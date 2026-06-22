'use strict';

const crypto = require('crypto');
const { fetch, Agent } = require('undici');
const mongoose = require('mongoose');
const YoutubeInsightReport = require('../models/youtubeInsightReport');
const YoutubeInsightPublicShare = require('../models/youtubeInsightPublicShare');
const { createInsightReport } = require('../services/youtubeInsight.service');
const {
  formatYoutubeInsightReport,
  getYoutubeLinkInsightSummary
} = require('../services/youtubeReportDashboard.service');
const saveErrorLog = require('../services/errorLog.service');

const ADMIN_ROLES_WITH_FULL_REPORT_ACCESS = new Set(['super_admin', 'revenue_head']);


const YT_API_KEYS = String(process.env.YOUTUBE_API_KEY || '')
  .split(',')
  .map((key) => key.trim())
  .filter(Boolean);
const YT_API_KEY = YT_API_KEYS[0] || '';
const YT_TIMEOUT_MS = Number(process.env.YOUTUBE_TIMEOUT_MS || 12000);
let ytApiKeyCursor = 0;

const youtubeHttpAgent = new Agent({
  keepAliveTimeout: 60_000,
  keepAliveMaxTimeout: 60_000,
});

const YT_CHANNELS = 'https://www.googleapis.com/youtube/v3/channels';
const YT_PLAYLIST_ITEMS = 'https://www.googleapis.com/youtube/v3/playlistItems';
const YT_SEARCH = 'https://www.googleapis.com/youtube/v3/search';
const YOUTUBE_VIDEO_ID_RE = /^[A-Za-z0-9_-]{11}$/;

function escapeRegex(value = '') {
  return String(value).replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

function clean(value) {
  return String(value || '').trim();
}

function isObject(value) {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function toObjectId(value) {
  const id = clean(value);
  return mongoose.Types.ObjectId.isValid(id) ? new mongoose.Types.ObjectId(id) : null;
}

function getBrandIdFromRequest(req = {}) {
  return clean(
    req.brand?._id ||
    req.brand?.id ||
    req.brand?.brandId ||
    req.user?.brandId ||
    req.user?.brand?._id ||
    req.user?.brand?.id ||
    req.admin?.brandId ||
    req.body?.brandId ||
    req.query?.brandId
  );
}

function getBrandNameFromRequest(req = {}) {
  return clean(
    req.brand?.brandName ||
    req.brand?.name ||
    req.user?.brandName ||
    req.user?.brand?.brandName ||
    req.admin?.brandName ||
    req.body?.brandName ||
    req.query?.brandName
  );
}

function shouldPersistFromRequest(req = {}) {
  const body = req.body || {};
  const sourceContext = clean(body.sourceContext || req.query?.sourceContext).toLowerCase();
  if (body.saveReport === false || body.persist === false || sourceContext === 'public_insight_os') return false;
  return true;
}

function getRequestActor(req = {}) {
  const admin = req.admin || null;
  const user = req.user || null;
  const adminId = clean(admin?.adminId || admin?._id);
  const userId = clean(user?._id || user?.id);
  return {
    adminId: adminId || null,
    userId: userId || null,
    id: adminId || userId || null,
    role: clean(admin?.role || user?.role).toLowerCase(),
    email: clean(admin?.email || user?.email).toLowerCase(),
    name: clean(admin?.name || user?.name),
    isAdmin: Boolean(adminId)
  };
}

function getYoutubeLinkFromRequest(req = {}) {
  const body = req.body || {};
  const query = req.query || {};
  return clean(
    body.videoUrl ||
    body.youtubeVideoUrl ||
    body.youtubeUrl ||
    body.videoLink ||
    body.link ||
    body.url ||
    body.videoId ||
    query.videoUrl ||
    query.youtubeUrl ||
    query.link ||
    query.url ||
    query.videoId
  );
}


function withYouTubeApiKey(url, apiKey) {
  const u = new URL(url);
  if (apiKey) u.searchParams.set('key', apiKey);
  return u.toString();
}

function shouldRetryWithNextYouTubeKey(status, bodyText = '') {
  const text = String(bodyText || '').toLowerCase();

  return (
    [400, 403, 429].includes(Number(status)) &&
    (
      text.includes('quotaexceeded') ||
      text.includes('dailylimitexceeded') ||
      text.includes('ratelimitexceeded') ||
      text.includes('userratelimitexceeded') ||
      text.includes('keyinvalid') ||
      text.includes('api key not valid') ||
      text.includes('forbidden')
    )
  );
}

async function youtubeApiFetch(url, timeoutMs = YT_TIMEOUT_MS) {
  if (!YT_API_KEYS.length) {
    const err = new Error('Missing YOUTUBE_API_KEY');
    err.status = 500;
    err.statusCode = 500;
    throw err;
  }

  let lastError = null;

  for (let attempt = 0; attempt < YT_API_KEYS.length; attempt += 1) {
    const keyIndex = (ytApiKeyCursor + attempt) % YT_API_KEYS.length;
    const requestUrl = withYouTubeApiKey(url, YT_API_KEYS[keyIndex]);
    const ac = new AbortController();
    const timeout = setTimeout(
      () => ac.abort(new Error('YouTube API timeout')),
      timeoutMs
    );

    try {
      const response = await fetch(requestUrl, {
        dispatcher: youtubeHttpAgent,
        signal: ac.signal,
      });

      if (!response.ok) {
        const bodyText = await response.text().catch(() => '');
        const err = new Error(`YouTube API ${response.status}: ${bodyText || response.statusText}`);
        err.status = response.status;
        err.statusCode = response.status;
        err.youtubeBody = bodyText;
        lastError = err;

        if (
          attempt < YT_API_KEYS.length - 1 &&
          shouldRetryWithNextYouTubeKey(response.status, bodyText)
        ) {
          continue;
        }

        throw err;
      }

      ytApiKeyCursor = keyIndex;
      return response.json();
    } finally {
      clearTimeout(timeout);
    }
  }

  throw lastError || new Error('YouTube API request failed');
}

function isYoutubeHost(hostname = '') {
  const host = String(hostname || '').toLowerCase();
  return host === 'youtu.be' || host.endsWith('.youtu.be') || host === 'youtube.com' || host.endsWith('.youtube.com');
}

function extractYoutubeVideoId(input = '') {
  const raw = clean(input);
  if (!raw) return null;

  if (YOUTUBE_VIDEO_ID_RE.test(raw) && !raw.startsWith('UC')) return raw;

  try {
    const url = new URL(raw);
    if (!isYoutubeHost(url.hostname)) return null;

    if (url.hostname.toLowerCase().includes('youtu.be')) {
      const id = clean(url.pathname.split('/').filter(Boolean)[0]);
      return YOUTUBE_VIDEO_ID_RE.test(id) ? id : null;
    }

    const fromQuery = clean(url.searchParams.get('v'));
    if (YOUTUBE_VIDEO_ID_RE.test(fromQuery)) return fromQuery;

    const parts = url.pathname.split('/').filter(Boolean);
    const videoPathKeys = new Set(['shorts', 'embed', 'live', 'v']);
    if (parts.length >= 2 && videoPathKeys.has(parts[0])) {
      const id = clean(parts[1]);
      return YOUTUBE_VIDEO_ID_RE.test(id) ? id : null;
    }
  } catch {
    return null;
  }

  return null;
}

function extractYoutubeHandle(input = '') {
  const raw = clean(input);
  if (!raw) return null;

  const match = raw.match(/@([A-Za-z0-9._-]+)/);
  if (!match?.[1]) return null;

  return `@${match[1]}`;
}

function extractYoutubeChannelId(input = '') {
  const raw = clean(input);
  if (!raw) return null;

  const match = raw.match(/\b(UC[A-Za-z0-9_-]{20,})\b/);
  return match?.[1] || null;
}

function getYoutubeUrlPathParts(input = '') {
  try {
    const url = new URL(clean(input));
    if (!isYoutubeHost(url.hostname)) return [];
    return url.pathname.split('/').filter(Boolean);
  } catch {
    return [];
  }
}

function getYoutubeUsernameOrCustomSlug(input = '') {
  const parts = getYoutubeUrlPathParts(input);
  if (!parts.length) return null;

  if (['user', 'c'].includes(parts[0]) && parts[1]) return clean(parts[1]);

  const reserved = new Set([
    'watch',
    'shorts',
    'embed',
    'live',
    'playlist',
    'results',
    'feed',
    'hashtag',
    'channel',
  ]);

  if (parts[0] && !reserved.has(parts[0]) && !parts[0].startsWith('@')) {
    return clean(parts[0]);
  }

  return null;
}

function isLikelyYoutubeProfileInput(input = '') {
  const raw = clean(input);
  if (!raw) return false;
  if (extractYoutubeVideoId(raw)) return false;
  if (extractYoutubeChannelId(raw) || extractYoutubeHandle(raw)) return true;

  const parts = getYoutubeUrlPathParts(raw);
  if (!parts.length) return false;

  return ['channel', 'user', 'c'].includes(parts[0]) || Boolean(getYoutubeUsernameOrCustomSlug(raw));
}

function youtubeVideoUrlFromId(videoId) {
  return `https://www.youtube.com/watch?v=${encodeURIComponent(videoId)}`;
}

async function fetchYoutubeChannelByParams(paramsObj = {}) {
  const params = new URLSearchParams({
    part: 'snippet,contentDetails',
    ...paramsObj,
    key: YT_API_KEY,
  });

  const data = await youtubeApiFetch(`${YT_CHANNELS}?${params.toString()}`);
  return Array.isArray(data?.items) ? data.items[0] || null : null;
}

async function fetchYoutubeChannelBySearch(query) {
  const safeQuery = clean(query);
  if (!safeQuery) return null;

  const params = new URLSearchParams({
    part: 'snippet',
    q: safeQuery,
    type: 'channel',
    maxResults: '1',
    key: YT_API_KEY,
  });

  const data = await youtubeApiFetch(`${YT_SEARCH}?${params.toString()}`);
  const channelId = data?.items?.[0]?.id?.channelId || data?.items?.[0]?.snippet?.channelId;
  return channelId ? fetchYoutubeChannelByParams({ id: channelId }) : null;
}

async function resolveYoutubeChannelFromInput(input = '') {
  const raw = clean(input);
  if (!raw) return null;

  const channelId = extractYoutubeChannelId(raw);
  if (channelId) return fetchYoutubeChannelByParams({ id: channelId });

  const handle = extractYoutubeHandle(raw);
  if (handle) return fetchYoutubeChannelByParams({ forHandle: handle });

  const slug = getYoutubeUsernameOrCustomSlug(raw);
  if (slug) {
    const byUsername = await fetchYoutubeChannelByParams({ forUsername: slug }).catch(() => null);
    if (byUsername) return byUsername;

    return fetchYoutubeChannelBySearch(slug);
  }

  return null;
}

function pickYoutubeThumbnail(thumbnails = {}) {
  return (
    thumbnails?.maxres?.url ||
    thumbnails?.standard?.url ||
    thumbnails?.high?.url ||
    thumbnails?.medium?.url ||
    thumbnails?.default?.url ||
    null
  );
}

async function fetchLatestVideoFromUploadsPlaylist(uploadsPlaylistId) {
  const playlistId = clean(uploadsPlaylistId);
  if (!playlistId) return null;

  const params = new URLSearchParams({
    part: 'snippet,contentDetails',
    playlistId,
    maxResults: '1',
    key: YT_API_KEY,
  });

  const data = await youtubeApiFetch(`${YT_PLAYLIST_ITEMS}?${params.toString()}`);
  const item = Array.isArray(data?.items) ? data.items[0] || null : null;
  const videoId = item?.contentDetails?.videoId || null;
  if (!videoId) return null;

  return {
    videoId,
    videoUrl: youtubeVideoUrlFromId(videoId),
    title: item?.snippet?.title || '',
    publishedAt: item?.contentDetails?.videoPublishedAt || item?.snippet?.publishedAt || null,
    thumbnailUrl: pickYoutubeThumbnail(item?.snippet?.thumbnails),
  };
}

async function resolveYoutubeInsightInput(input = '') {
  const originalInput = clean(input);
  const videoId = extractYoutubeVideoId(originalInput);

  if (videoId) {
    return {
      originalInput,
      inputType: 'video',
      resolvedFromProfile: false,
      videoId,
      videoUrl: youtubeVideoUrlFromId(videoId),
      channel: null,
      latestVideo: null,
    };
  }

  if (!isLikelyYoutubeProfileInput(originalInput)) {
    return {
      originalInput,
      inputType: 'unknown',
      resolvedFromProfile: false,
      videoId: null,
      videoUrl: originalInput,
      channel: null,
      latestVideo: null,
    };
  }

  const channel = await resolveYoutubeChannelFromInput(originalInput);

  if (!channel) {
    const err = new Error('YouTube profile/channel not found. Please provide a valid YouTube video link or channel/profile link.');
    err.status = 404;
    err.statusCode = 404;
    throw err;
  }

  const uploadsPlaylistId = channel?.contentDetails?.relatedPlaylists?.uploads || '';
  const latestVideo = await fetchLatestVideoFromUploadsPlaylist(uploadsPlaylistId);

  if (!latestVideo?.videoUrl) {
    const err = new Error('No public latest video found for this YouTube profile/channel.');
    err.status = 404;
    err.statusCode = 404;
    throw err;
  }

  const snippet = channel?.snippet || {};

  return {
    originalInput,
    inputType: 'profile',
    resolvedFromProfile: true,
    videoId: latestVideo.videoId,
    videoUrl: latestVideo.videoUrl,
    channel: {
      channelId: channel?.id || null,
      title: snippet?.title || '',
      handle: snippet?.customUrl || null,
      channelUrl: channel?.id ? `https://www.youtube.com/channel/${channel.id}` : originalInput,
      thumbnailUrl: pickYoutubeThumbnail(snippet?.thumbnails),
    },
    latestVideo,
  };
}

function canViewAllReports(req = {}) {
  const actor = getRequestActor(req);
  return actor.isAdmin && ADMIN_ROLES_WITH_FULL_REPORT_ACCESS.has(actor.role);
}

function buildAccessFilter(req = {}) {
  const actor = getRequestActor(req);
  const brandObjectId = toObjectId(getBrandIdFromRequest(req));
  if (brandObjectId) return { brandId: brandObjectId };
  if (canViewAllReports(req)) return {};
  if (actor.adminId && mongoose.Types.ObjectId.isValid(actor.adminId)) return { createdByAdminId: actor.adminId };
  if (actor.userId && mongoose.Types.ObjectId.isValid(actor.userId)) return { userId: actor.userId };
  return { _id: null };
}

function getListInput(req = {}) {
  return { ...(req.query || {}), ...(req.body || {}) };
}

function addOptionalFilters(filter, input = {}) {
  const brandObjectId = toObjectId(input.brandId);
  if (brandObjectId) filter.brandId = brandObjectId;
  if (input.sourceContext) filter.sourceContext = clean(input.sourceContext);
  if (input.videoId) filter.videoId = clean(input.videoId);
  if (input.channelId) filter['channelMetrics.channelId'] = clean(input.channelId);
  if (input.reportStatus) filter.reportStatus = clean(input.reportStatus);
  if (input.category) filter['creatorInsights.primaryCategory'] = new RegExp(escapeRegex(clean(input.category)), 'i');
  if (input.influencerName) filter['hero.influencerName'] = new RegExp(escapeRegex(clean(input.influencerName)), 'i');
  if (input.search) {
    const search = new RegExp(escapeRegex(clean(input.search)), 'i');
    filter.$or = [
      { 'hero.influencerName': search },
      { 'videoMetrics.title': search },
      { 'channelMetrics.title': search },
      { 'creatorInsights.primaryCategory': search }
    ];
  }
  const fromDate = input.fromDate || input.startDate;
  const toDate = input.toDate || input.endDate;
  if (fromDate || toDate) {
    filter.createdAt = {};
    if (fromDate) filter.createdAt.$gte = new Date(fromDate);
    if (toDate) filter.createdAt.$lte = new Date(toDate);
  }
  return filter;
}

function formatYoutubeInsightListItem(report = {}) {
  const dashboard = report.dashboard || {};
  const hero = dashboard.hero || report.hero || {};
  const profile = dashboard.profile || {};
  const video = report.videoMetrics || {};
  const channel = report.channelMetrics || {};
  const finalVerdict = dashboard.finalVerdict || report.finalVerdict || {};
  const revenue = dashboard.estimatedRevenue || {};
  const watch = dashboard.estimatedWatchTime || {};
  const creator = dashboard.creatorFit || dashboard.influencerCategory || report.creatorInsights || {};

  return {
    reportId: String(report._id || report.reportId || ''),
    reportType: report.reportType || 'YouTube Link Intelligence Report',
    platform: 'YouTube',
    reportStatus: report.reportStatus || 'Published',
    generatedAt: report.createdAt || report.generatedAt || null,
    influencerName: profile.name || hero.influencerName || channel.title || '',
    influencerCategory: creator.primaryCategory || video.categoryName || '',
    videoTitle: dashboard.videoOverview?.title || hero.videoTitle || video.title || '',
    thumbnailUrl: dashboard.videoOverview?.thumbnailUrl || hero.thumbnailUrl || video.thumbnailUrl || '',
    channelLogo: profile.avatarUrl || hero.channelThumbnailUrl || channel.thumbnailUrl || '',
    videoUrl: dashboard.videoOverview?.videoUrl || hero.livePublishedLink || report.videoUrl || '',
    channelUrl: profile.channelUrl || hero.channelUrl || channel.channelUrl || '',
    subscribersDisplay: profile.subscriberCountDisplay || channel.subscriberCountDisplay || '',
    channelTotalViewsDisplay: profile.totalViewCountDisplay || channel.totalViewCountDisplay || '',
    channelTotalVideosDisplay: profile.videoCountDisplay || channel.videoCountDisplay || '',
    views: video.viewCount || 0,
    likes: video.likeCount || 0,
    comments: video.commentCount || 0,
    engagementRate: video.engagementRate || 0,
    durationDisplay: video.durationDisplay || dashboard.videoOverview?.durationDisplay || '',
    estimatedCtrDisplay: report.performanceEstimates?.estimatedCtr?.displayValue || '',
    estimatedConversionRateDisplay: report.performanceEstimates?.estimatedConversionRate?.displayValue || '',
    estimatedWatchTimeHoursDisplay: watch.totalWatchTimeHours?.displayValue || '',
    estimatedRevenueRangeDisplay: revenue.estimatedRevenueRangeDisplay || '',
    finalAiScore: finalVerdict.finalScore || report.aiScores?.finalAiScore || 0,
    verdict: finalVerdict.verdict || ''
  };
}


function getPublicWebBaseUrl(req = {}, body = {}) {
  const direct = clean(body.publicBaseUrl || body.origin || body.siteUrl || body.webBaseUrl);
  const envUrl = clean(process.env.PUBLIC_WEB_URL || process.env.NEXT_PUBLIC_APP_URL || process.env.FRONTEND_URL || process.env.CLIENT_URL);
  const host = clean(req.headers?.origin) || clean(req.headers?.referer).replace(/\/[^/]*$/, '');
  return (direct || envUrl || host || 'https://collabglam.com').replace(/\/+$/, '');
}

function makePublicReportUrl(token, req = {}, body = {}) {
  const base = getPublicWebBaseUrl(req, body);
  return `${base}/insight-os/report?share=${encodeURIComponent(token)}`;
}

function getSnapshotFromRequest(body = {}) {
  if (isObject(body.frontendReport)) return body.frontendReport;
  if (isObject(body.dashboard)) return body.dashboard;
  if (isObject(body.report)) return body.report;
  if (isObject(body.data)) return body.data;
  return null;
}

function getSnapshotTitle(snapshot = {}) {
  if (!isObject(snapshot)) return '';
  return clean(
    snapshot.videoOverview?.title ||
    snapshot.hero?.videoTitle ||
    snapshot.videoTitle ||
    snapshot.title ||
    snapshot.profile?.name ||
    snapshot.hero?.influencerName
  );
}

function getSnapshotCreatorName(snapshot = {}) {
  if (!isObject(snapshot)) return '';
  return clean(
    snapshot.profile?.name ||
    snapshot.hero?.influencerName ||
    snapshot.influencerName ||
    snapshot.channelOverview?.name ||
    snapshot.creatorName
  );
}

function getSnapshotVideoUrl(snapshot = {}) {
  if (!isObject(snapshot)) return '';
  return clean(
    snapshot.videoOverview?.videoUrl ||
    snapshot.hero?.livePublishedLink ||
    snapshot.videoUrl ||
    snapshot.url
  );
}

function getRequestActorIds(req = {}) {
  const actor = getRequestActor(req);
  return {
    actor,
    createdByAdminId: actor.adminId && mongoose.Types.ObjectId.isValid(actor.adminId) ? actor.adminId : null,
    createdByUserId: actor.userId && mongoose.Types.ObjectId.isValid(actor.userId) ? actor.userId : null,
    createdByEmail: actor.email || ''
  };
}

function makeShareToken() {
  return crypto.randomBytes(24).toString('base64url');
}

async function createYoutubeInsightPublicLink(req, res, next) {
  try {
    const body = req.body || {};
    const reportId = clean(body.reportId || body.id || body._id);
    const snapshot = getSnapshotFromRequest(body);
    const sourceContext = clean(body.sourceContext || body.context).toLowerCase() || 'unknown';
    const { actor, createdByAdminId, createdByUserId, createdByEmail } = getRequestActorIds(req);

    let report = null;

    if (reportId) {
      if (!mongoose.Types.ObjectId.isValid(reportId)) {
        return res.status(400).json({ success: false, message: 'Invalid YouTube insight report id.' });
      }

      // Authenticated brand/admin users may share a saved report. Public users can
      // still share the report snapshot without requiring DB report access.
      const accessFilter = actor.id ? buildAccessFilter(req) : null;
      if (accessFilter) {
        report = await YoutubeInsightReport.findOne({ ...accessFilter, _id: reportId }).lean();
        if (!report && !snapshot) {
          return res.status(404).json({ success: false, message: 'YouTube insight report not found.' });
        }
      }
    }

    if (!report && !snapshot) {
      return res.status(400).json({
        success: false,
        message: 'reportId or frontendReport/dashboard snapshot is required to create a public link.'
      });
    }

    const token = makeShareToken();
    const reportObjectId = report?._id || (reportId && mongoose.Types.ObjectId.isValid(reportId) && actor.id ? reportId : null);
    const brandObjectId = report?.brandId || toObjectId(body.brandId) || toObjectId(getBrandIdFromRequest(req));
    const frontendSnapshot = snapshot || null;

    const share = await YoutubeInsightPublicShare.create({
      token,
      reportId: reportObjectId,
      brandId: brandObjectId,
      brandName: clean(report?.brandName || body.brandName || getBrandNameFromRequest(req)),
      sourceContext: ['public_insight_os', 'brand_insight_os'].includes(sourceContext) ? sourceContext : (report?.sourceContext || 'unknown'),
      title: clean(report?.videoMetrics?.title || report?.hero?.videoTitle || getSnapshotTitle(frontendSnapshot)),
      creatorName: clean(report?.hero?.influencerName || report?.channelMetrics?.title || getSnapshotCreatorName(frontendSnapshot)),
      videoUrl: clean(report?.videoUrl || report?.hero?.livePublishedLink || getSnapshotVideoUrl(frontendSnapshot)),
      snapshot: frontendSnapshot,
      createdByAdminId,
      createdByUserId,
      createdByEmail
    });

    const publicUrl = makePublicReportUrl(share.token, req, body);

    return res.status(201).json({
      success: true,
      message: 'Public Insight OS report link created successfully.',
      data: {
        token: share.token,
        shareToken: share.token,
        publicUrl,
        url: publicUrl,
        reportId: share.reportId ? String(share.reportId) : ''
      }
    });
  } catch (error) {
    await saveErrorLog(
      req,
      error,
      error?.response?.status || error?.statusCode || error?.status || 500,
      "CREATE_YOUTUBE_INSIGHT_PUBLIC_LINK_ERROR"
    );

    return next(error);
  }
}

async function getYoutubeInsightPublicShare(req, res, next) {
  try {
    const token = clean(req.params.token || req.query.share || req.query.token);
    if (!token) return res.status(400).json({ success: false, message: 'Public report token is required.' });

    const share = await YoutubeInsightPublicShare.findOne({ token, isActive: true }).lean();
    if (!share) return res.status(404).json({ success: false, message: 'Public Insight OS report link not found.' });

    if (share.expiresAt && new Date(share.expiresAt).getTime() < Date.now()) {
      return res.status(410).json({ success: false, message: 'This public Insight OS report link has expired.' });
    }

    await YoutubeInsightPublicShare.updateOne(
      { _id: share._id },
      { $inc: { accessCount: 1 }, $set: { lastAccessedAt: new Date() } }
    ).catch(() => null);

    if (share.reportId) {
      const report = await YoutubeInsightReport.findById(share.reportId).lean();
      if (report) {
        const formattedReport = formatYoutubeInsightReport(report, {
          includeRawData: false,
          includeRawReport: false,
          includeDebug: false
        });

        return res.status(200).json({
          success: true,
          data: formattedReport,
          reportId: formattedReport.reportId,
          frontendReport: formattedReport.frontendReport,
          dashboard: formattedReport.dashboard,
          aiSummary: formattedReport.aiSummary,
          aiInsights: formattedReport.aiInsights,
          finalVerdict: formattedReport.finalVerdict,
          publicShare: {
            token: share.token,
            title: share.title,
            creatorName: share.creatorName,
            createdAt: share.createdAt
          }
        });
      }
    }

    if (!share.snapshot) {
      return res.status(404).json({ success: false, message: 'Public report snapshot is not available.' });
    }

    return res.status(200).json({
      success: true,
      data: {
        reportId: share.reportId ? String(share.reportId) : '',
        frontendReport: share.snapshot,
        dashboard: share.snapshot,
        publicShare: {
          token: share.token,
          title: share.title,
          creatorName: share.creatorName,
          createdAt: share.createdAt
        }
      },
      reportId: share.reportId ? String(share.reportId) : '',
      frontendReport: share.snapshot,
      dashboard: share.snapshot,
      publicShare: {
        token: share.token,
        title: share.title,
        creatorName: share.creatorName,
        createdAt: share.createdAt
      }
    });
  } catch (error) {
    await saveErrorLog(
      req,
      error,
      error?.response?.status || error?.statusCode || error?.status || 500,
      "GET_YOUTUBE_INSIGHT_PUBLIC_SHARE_ERROR"
    );

    return next(error);
  }
}


async function analyzeYoutubeVideo(req, res, next) {
  try {
    const actor = getRequestActor(req);
    const videoUrl = getYoutubeLinkFromRequest(req);
    const body = req.body || {};
    const persistReport = shouldPersistFromRequest(req);
    const brandId = getBrandIdFromRequest(req);
    const brandName = getBrandNameFromRequest(req);

    if (persistReport && !brandId) {
      return res.status(400).json({ success: false, message: 'brandId is required for brand Insight OS saved reports.' });
    }

    const resolvedYoutubeInput = await resolveYoutubeInsightInput(videoUrl);

    const report = await createInsightReport({
      actor,
      payload: {
        videoUrl: resolvedYoutubeInput.videoUrl,
        originalYoutubeInput: resolvedYoutubeInput.originalInput,
        resolvedFromProfile: resolvedYoutubeInput.resolvedFromProfile,
        sourceProfile: resolvedYoutubeInput.channel,
        sourceLatestVideo: resolvedYoutubeInput.latestVideo,
        saveReport: persistReport,
        sourceContext: persistReport ? 'brand_insight_os' : 'public_insight_os',
        brandId,
        brandName,
        maxComments: body.maxComments,
        creatorAverageLimit: body.creatorAverageLimit,
        includeReplies: body.includeReplies,
        includeRepliesInAnalysis: body.includeRepliesInAnalysis,
        maxRepliesPerThread: body.maxRepliesPerThread,
        commentOrder: body.commentOrder,
        rpmLow: body.rpmLow,
        rpmHigh: body.rpmHigh
      }
    });

    const formattedReport = formatYoutubeInsightReport(report, {
      includeRawData: req.query.includeRaw === 'true',
      includeRawReport: req.query.includeRaw === 'true',
      includeDebug: req.query.debug === 'true'
    });

    return res.status(201).json({
      success: true,
      message: resolvedYoutubeInput.resolvedFromProfile
        ? 'YouTube profile resolved to latest video and insight generated successfully.'
        : 'YouTube link insight generated successfully.',
      saved: persistReport,
      resolvedYoutubeInput,
      data: formattedReport,
      reportId: formattedReport.reportId,
      frontendReport: formattedReport.frontendReport,
      dashboard: formattedReport.dashboard,
      aiSummary: formattedReport.aiSummary,
      aiInsights: formattedReport.aiInsights,
      finalVerdict: formattedReport.finalVerdict
    });
  } catch (error) {
    await saveErrorLog(
      req,
      error,
      error?.response?.status || error?.statusCode || error?.status || 500,
      "ANALYZE_YOUTUBE_VIDEO_ERROR"
    );

    return next(error);
  }
}

async function getYoutubeInsightReports(req, res, next) {
  try {
    const input = getListInput(req);
    const page = Math.max(Number(input.page || 1), 1);
    const limit = Math.min(Math.max(Number(input.limit || 20), 1), 100);
    const skip = (page - 1) * limit;
    const sortBy = clean(input.sortBy) || 'createdAt';
    const sortOrder = clean(input.sortOrder).toLowerCase() === 'asc' ? 1 : -1;
    const allowedSorts = new Set(['createdAt', 'updatedAt', 'videoId', 'hero.influencerName', 'videoMetrics.title', 'videoMetrics.viewCount', 'videoMetrics.likeCount', 'videoMetrics.commentCount', 'videoMetrics.engagementRate', 'channelMetrics.subscriberCount', 'channelMetrics.totalViewCount', 'aiScores.finalAiScore', 'creatorInsights.primaryCategory']);
    const filter = addOptionalFilters(buildAccessFilter(req), input);
    const sort = { [allowedSorts.has(sortBy) ? sortBy : 'createdAt']: sortOrder };
    const [items, total] = await Promise.all([
      YoutubeInsightReport.find(filter).sort(sort).skip(skip).limit(limit).lean(),
      YoutubeInsightReport.countDocuments(filter)
    ]);
    return res.status(200).json({ success: true, data: items.map(formatYoutubeInsightListItem), pagination: { page, limit, total, totalPages: Math.ceil(total / limit) } });
  } catch (error) {
    await saveErrorLog(
      req,
      error,
      error?.response?.status || error?.statusCode || error?.status || 500,
      "GET_YOUTUBE_INSIGHT_REPORTS_ERROR"
    );

    return next(error);
  }
}

async function getYoutubeInsightReportById(req, res, next) {
  try {
    const reportId = clean(req.params.id);
    if (!mongoose.Types.ObjectId.isValid(reportId)) return res.status(400).json({ success: false, message: 'Invalid YouTube insight report id.' });
    const report = await YoutubeInsightReport.findOne({ ...buildAccessFilter(req), _id: reportId }).lean();
    if (!report) return res.status(404).json({ success: false, message: 'YouTube insight report not found.' });
    const formattedReport = formatYoutubeInsightReport(report, {
      includeRawData: req.query.includeRaw === 'true',
      includeRawReport: req.query.includeRaw === 'true',
      includeDebug: req.query.debug === 'true'
    });

    return res.status(200).json({
      success: true,
      data: formattedReport,
      reportId: formattedReport.reportId,
      frontendReport: formattedReport.frontendReport,
      dashboard: formattedReport.dashboard,
      aiSummary: formattedReport.aiSummary,
      aiInsights: formattedReport.aiInsights,
      finalVerdict: formattedReport.finalVerdict
    });
  } catch (error) {
    await saveErrorLog(
      req,
      error,
      error?.response?.status || error?.statusCode || error?.status || 500,
      "GET_YOUTUBE_INSIGHT_REPORT_BY_ID_ERROR"
    );

    return next(error);
  }
}

async function refreshYoutubeInsightReportById(req, res, next) {
  try {
    const reportId = clean(req.params.id);

    if (!mongoose.Types.ObjectId.isValid(reportId)) {
      return res.status(400).json({
        success: false,
        message: 'Invalid YouTube insight report id.'
      });
    }

    const existingReport = await YoutubeInsightReport.findOne({
      ...buildAccessFilter(req),
      _id: reportId
    }).lean();

    if (!existingReport) {
      return res.status(404).json({
        success: false,
        message: 'YouTube insight report not found.'
      });
    }

    const videoUrl = clean(
      existingReport.videoUrl ||
      existingReport.hero?.livePublishedLink ||
      existingReport.videoMetrics?.videoUrl ||
      existingReport.dashboard?.videoOverview?.videoUrl ||
      existingReport.channelMetrics?.channelUrl ||
      existingReport.hero?.channelUrl ||
      existingReport.dashboard?.profile?.channelUrl
    );

    if (!videoUrl) {
      return res.status(400).json({
        success: false,
        message: 'Video URL or channel URL is missing for this report.'
      });
    }

    const resolvedYoutubeInput = await resolveYoutubeInsightInput(videoUrl);
    const actor = getRequestActor(req);

    const refreshedReport = await createInsightReport({
      actor,
      payload: {
        videoUrl: resolvedYoutubeInput.videoUrl,
        originalYoutubeInput: resolvedYoutubeInput.originalInput,
        resolvedFromProfile: resolvedYoutubeInput.resolvedFromProfile,
        sourceProfile: resolvedYoutubeInput.channel,
        sourceLatestVideo: resolvedYoutubeInput.latestVideo,
        saveReport: false,
        sourceContext: existingReport.sourceContext || 'brand_insight_os',
        brandId: existingReport.brandId ? String(existingReport.brandId) : getBrandIdFromRequest(req),
        brandName: existingReport.brandName || getBrandNameFromRequest(req),

        maxComments: req.body?.maxComments,
        creatorAverageLimit: req.body?.creatorAverageLimit,
        includeReplies: req.body?.includeReplies,
        includeRepliesInAnalysis: req.body?.includeRepliesInAnalysis,
        maxRepliesPerThread: req.body?.maxRepliesPerThread,
        commentOrder: req.body?.commentOrder,
        rpmLow: req.body?.rpmLow,
        rpmHigh: req.body?.rpmHigh
      }
    });

    const updateData = refreshedReport.toObject
      ? refreshedReport.toObject()
      : { ...refreshedReport };

    delete updateData._id;
    delete updateData.id;
    delete updateData.reportId;
    delete updateData.createdAt;
    delete updateData.updatedAt;
    delete updateData.brandId;
    delete updateData.brandName;
    delete updateData.createdByAdminId;
    delete updateData.createdByUserId;
    delete updateData.createdByEmail;
    delete updateData.userId;

    updateData.lastRefreshedAt = new Date();

    const updatedReport = await YoutubeInsightReport.findOneAndUpdate(
      {
        ...buildAccessFilter(req),
        _id: reportId
      },
      {
        $set: updateData
      },
      {
        new: true
      }
    ).lean();

    if (!updatedReport) {
      return res.status(404).json({
        success: false,
        message: 'YouTube insight report not found after refresh.'
      });
    }

    const formattedReport = formatYoutubeInsightReport(updatedReport, {
      includeRawData: req.query.includeRaw === 'true',
      includeRawReport: req.query.includeRaw === 'true',
      includeDebug: req.query.debug === 'true'
    });

    return res.status(200).json({
      success: true,
      message: resolvedYoutubeInput.resolvedFromProfile
        ? 'YouTube profile resolved to latest video and insight report refreshed successfully.'
        : 'YouTube insight report refreshed successfully.',
      resolvedYoutubeInput,
      data: formattedReport,
      reportId: formattedReport.reportId,
      frontendReport: formattedReport.frontendReport,
      dashboard: formattedReport.dashboard,
      aiSummary: formattedReport.aiSummary,
      aiInsights: formattedReport.aiInsights,
      finalVerdict: formattedReport.finalVerdict
    });
  } catch (error) {
    return next(error);
  }
}

async function getYoutubeInsightSummary(req, res, next) {
  try {
    const input = getListInput(req);
    const filter = addOptionalFilters(buildAccessFilter(req), input);
    const summary = await getYoutubeLinkInsightSummary({ filter, limit: input.limit || 500 });
    return res.status(200).json({ success: true, data: summary });
  } catch (error) {
    await saveErrorLog(
      req,
      error,
      error?.response?.status || error?.statusCode || error?.status || 500,
      "GET_YOUTUBE_INSIGHT_SUMMARY_ERROR"
    );

    return next(error);
  }
}

async function deleteYoutubeInsightReport(req, res, next) {
  try {
    const reportId = clean(req.params.id);
    if (!mongoose.Types.ObjectId.isValid(reportId)) return res.status(400).json({ success: false, message: 'Invalid YouTube insight report id.' });
    const report = await YoutubeInsightReport.findOneAndDelete({ ...buildAccessFilter(req), _id: reportId });
    if (!report) return res.status(404).json({ success: false, message: 'YouTube insight report not found.' });
    return res.status(200).json({ success: true, message: 'YouTube insight report deleted successfully.' });
  } catch (error) {
    await saveErrorLog(
      req,
      error,
      error?.response?.status || error?.statusCode || error?.status || 500,
      "DELETE_YOUTUBE_INSIGHT_REPORT_ERROR"
    );

    return next(error);
  }
}

module.exports = {
  analyzeYoutubeVideo,
  getYoutubeInsightReports,
  getYoutubeInsightReportById,
  refreshYoutubeInsightReportById,
  getYoutubeInsightSummary,
  deleteYoutubeInsightReport,
  createYoutubeInsightPublicLink,
  getYoutubeInsightPublicShare
};