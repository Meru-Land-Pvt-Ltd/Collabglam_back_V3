const mongoose = require("mongoose");
const Invitation = require("../models/NewInvitations");
const MissingEmail = require("../models/MissingEmail");
const Campaign = require("../models/campaign");
const { InfluencerModel } = require("../models/influencer");
const { EmailThread, EmailMessage } = require("../models/email");
const Brand = require("../models/brand");
const {
  sendEmail,
  cleanEmail,
  cleanStr,
} = require("../services/email/invitationEmailService");

const saveErrorLog = require("../services/errorLog.service");

const HANDLE_RX = /^@[A-Za-z0-9._\-]+$/;
const EMAIL_RX = /\b[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}\b/i;

const PLATFORM_MAP = new Map([
  ["youtube", "youtube"],
  ["yt", "youtube"],
  ["instagram", "instagram"],
  ["ig", "instagram"],
  ["tiktok", "tiktok"],
  ["tt", "tiktok"],
]);

const PLATFORM_ENUM = new Set(["youtube", "instagram", "tiktok"]);
const STATUS_ENUM = new Set(["invited", "available"]);

const isObjectId = (value) =>
  mongoose.Types.ObjectId.isValid(String(value || ""));

function normalizeObjectId(value) {
  const id = String(value || "").trim();
  return isObjectId(id) ? id : "";
}

function toObjectId(value) {
  return new mongoose.Types.ObjectId(String(value));
}

function toPlainId(value) {
  if (!value) return null;
  if (typeof value === "object" && value._id) return String(value._id);
  return String(value);
}

function normalizeHandle(h) {
  if (!h) return "";
  const t = String(h).trim().toLowerCase();
  return t.startsWith("@") ? t : `@${t}`;
}

function normalizePlatform(value) {
  return PLATFORM_MAP.get(String(value || "").trim().toLowerCase()) || "";
}

function escapeRegExp(value = "") {
  return String(value).replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

function normalizeInfluencerUserId(body = {}) {
  return (
    String(
      body.userId ||
      body.influencerUserId ||
      body.creatorId ||
      body.influencerId ||
      body.modashUserId ||
      body.channelId ||
      body.youtubeChannelId ||
      ""
    ).trim() || null
  );
}

function getHeaderValue(headers = {}, keys = []) {
  for (const key of keys) {
    const value = headers[key] || headers[String(key).toLowerCase()];
    if (value) return String(value).trim();
  }

  return "";
}

function getRequestChannelId(req = {}) {
  const body = req.body || {};
  const headers = req.headers || {};

  return (
    String(
      body.channelId ||
      body.youtubeChannelId ||
      body.youtube?.channelId ||
      body.creator?.channelId ||
      body.influencer?.channelId ||
      getHeaderValue(headers, [
        "channelid",
        "channelId",
        "channel-id",
        "x-channel-id",
        "youtube-channel-id",
        "x-youtube-channel-id",
      ]) ||
      ""
    ).trim() || null
  );
}

function getRequestDirectRecipientEmail(req = {}) {
  const body = req.body || {};
  const headers = req.headers || {};

  return getFirstDirectEmail(
    body.recipientEmail,
    body.influencerEmail,
    body.creatorEmail,
    body.businessEmail,
    body.contactEmail,
    typeof body.email === "string" ? body.email : null,
    body.creator?.email,
    body.influencer?.email,
    getHeaderValue(headers, [
      "recipient-email",
      "x-recipient-email",
      "influencer-email",
      "x-influencer-email",
      "creator-email",
      "x-creator-email",
    ])
  );
}

function normalizeCampaignIds(body = {}) {
  const rawCampaignIds = Array.isArray(body.campaignIds)
    ? body.campaignIds
    : Array.isArray(body.campaignId)
      ? body.campaignId
      : [body.campaignId];

  return [
    ...new Set(
      rawCampaignIds.map((id) => normalizeObjectId(id)).filter(Boolean)
    ),
  ];
}

function normalizeEmailText(value = "") {
  return String(value || "")
    .replace(/\s*(\[|\()?at(\]|\))?\s*/gi, "@")
    .replace(/\s*(\[|\()?dot(\]|\))?\s*/gi, ".");
}

function extractEmailFromText(value = "") {
  const normalized = normalizeEmailText(value);
  const match = normalized.match(EMAIL_RX);
  return match ? cleanEmail(match[0]) : null;
}

function getFirstDirectEmail(...values) {
  for (const value of values) {
    const email = cleanEmail(value);
    if (email) return email;
  }

  return null;
}

function getEmailFromContactsTypeEmail(contacts) {
  if (!Array.isArray(contacts)) return null;

  const emailContact = contacts.find((item) => {
    if (!item || typeof item !== "object") return false;

    const type = String(item.type || "").trim().toLowerCase();
    const email = getFirstDirectEmail(
      item.value,
      item.email,
      item.contactEmail,
      item.businessEmail,
      item.emailAddress
    );

    return type === "email" && email;
  });

  if (!emailContact) return null;

  return getFirstDirectEmail(
    emailContact.value,
    emailContact.email,
    emailContact.contactEmail,
    emailContact.businessEmail,
    emailContact.emailAddress
  );
}

function getDirectEmailFromMixedValue(value, depth = 0) {
  if (!value || depth > 4) return null;

  if (typeof value === "string") {
    return extractEmailFromText(value);
  }

  if (Array.isArray(value)) {
    for (const item of value) {
      const email = getDirectEmailFromMixedValue(item, depth + 1);
      if (email) return email;
    }

    return null;
  }

  if (typeof value === "object") {
    const directEmail = getFirstDirectEmail(
      value.email,
      value.businessEmail,
      value.contactEmail,
      value.emailAddress,
      value.proxyEmail,
      value.value
    );

    if (directEmail) return directEmail;

    for (const item of Object.values(value)) {
      const email = getDirectEmailFromMixedValue(item, depth + 1);
      if (email) return email;
    }
  }

  return null;
}

function toEmailArray(input) {
  if (Array.isArray(input)) {
    return input.map((item) => cleanEmail(item)).filter(Boolean);
  }

  if (typeof input === "string") {
    return input.split(",").map((item) => cleanEmail(item)).filter(Boolean);
  }

  const email = cleanEmail(input);
  return email ? [email] : [];
}

function uniqueEmails(values) {
  return [...new Set(values.map((item) => cleanEmail(item)).filter(Boolean))];
}

function normalizeEmailTemplate(body = {}, { brand, fallbackSubject = "" } = {}) {
  const template = body.emailTemplate || body.email || {};

  const subject = cleanStr(
    template.subject ||
    body.subject ||
    body.emailSubject ||
    fallbackSubject ||
    ""
  );

  const text = String(
    template.textBody ||
    template.body ||
    body.textBody ||
    body.body ||
    body.emailBody ||
    ""
  ).trim();

  const html = String(
    template.htmlBody ||
    body.htmlBody ||
    body.emailHtmlBody ||
    ""
  ).trim();

  const fromEmail = cleanEmail(
    template.fromEmail ||
    template.from ||
    body.fromEmail ||
    body.emailFrom ||
    brand?.proxyEmail
  );

  const replyTo = fromEmail ? [fromEmail] : [];

  const cc = toEmailArray(template.cc || body.cc);
  const bcc = toEmailArray(template.bcc || body.bcc);

  const rawAttachments =
    template.attachments || body.emailAttachments || body.attachments || [];

  const attachments = Array.isArray(rawAttachments)
    ? rawAttachments
      .filter((file) => file?.filename && (file?.contentBase64 || file?.content))
      .map((file) => ({
        filename: cleanStr(file.filename),
        contentType:
          file.contentType || file.mimeType || "application/octet-stream",
        content: String(file.contentBase64 || file.content || "").replace(
          /^data:.*;base64,/,
          ""
        ),
        encoding: "base64",
      }))
    : [];

  if (!fromEmail) {
    return {
      error:
        "Brand proxyEmail or emailTemplate.fromEmail is required to send invitation email.",
    };
  }

  if (!subject || (!text && !html)) {
    return {
      error: "Email subject and body are required.",
    };
  }

  return {
    from: fromEmail,
    subject,
    text,
    html,
    cc,
    bcc,
    replyTo,
    attachments,
  };
}

function buildEmailTemplateSnapshot(emailTemplate) {
  if (!emailTemplate || emailTemplate.error) return undefined;

  return {
    from: cleanEmail(emailTemplate.from) || null,
    subject: cleanStr(emailTemplate.subject || ""),
    text: String(emailTemplate.text || ""),
    html: String(emailTemplate.html || ""),
    cc: uniqueEmails(emailTemplate.cc || []),
    bcc: uniqueEmails(emailTemplate.bcc || []),
    replyTo: uniqueEmails(emailTemplate.replyTo || []),
    attachmentNames: Array.isArray(emailTemplate.attachments)
      ? emailTemplate.attachments
        .map((file) => cleanStr(file?.filename || ""))
        .filter(Boolean)
      : [],
  };
}

function buildMissingEmailCampaignSnapshot({
  brandId,
  campaignId,
  campaign,
  campaignName,
  emailTemplate,
}) {
  if (!campaignId) return null;

  return {
    brandId: String(brandId || ""),
    campaignId: String(campaignId || ""),
    campaignName: cleanStr(
      campaignName ||
      campaign?.campaignTitle ||
      campaign?.campaignName ||
      campaign?.title ||
      ""
    ),
    emailTemplate: buildEmailTemplateSnapshot(emailTemplate),
    requestedAt: new Date(),
  };
}

function buildRequestCreatorSource(req = {}, fallback = {}) {
  const body = req.body || {};
  const channelId = getRequestChannelId(req);

  return {
    ...fallback,
    ...body.creator,
    ...body.influencer,
    ...body.youtube,

    channelId:
      channelId ||
      body.channelId ||
      body.youtubeChannelId ||
      fallback.channelId ||
      fallback.userId ||
      fallback.id ||
      undefined,

    handle: fallback.handle || body.handle || body.creator?.handle,

    title:
      body.title ||
      body.creatorTitle ||
      body.influencerTitle ||
      body.creator?.title ||
      body.influencer?.title ||
      body.youtube?.title ||
      fallback.title ||
      fallback.name ||
      fallback.fullName ||
      fallback.fullname,

    urlByHandle:
      body.urlByHandle ||
      body.profileUrl ||
      body.creator?.profileUrl ||
      body.youtube?.urlByHandle ||
      fallback.urlByHandle ||
      fallback.profileUrl ||
      fallback.url,

    urlById:
      body.urlById ||
      body.channelUrl ||
      body.youtube?.urlById ||
      fallback.urlById ||
      fallback.channelUrl,

    description:
      body.description ||
      body.bio ||
      body.about ||
      body.creator?.description ||
      body.influencer?.description ||
      body.youtube?.description ||
      fallback.description ||
      fallback.bio ||
      fallback.about,

    country:
      body.country ||
      body.creator?.country ||
      body.influencer?.country ||
      body.youtube?.country ||
      fallback.country ||
      fallback.location?.country,
  };
}

function buildMissingYouTubePayload(source, handle) {
  const safeSource = source && typeof source === "object" ? source : {};

  return {
    channelId:
      safeSource.channelId ||
      safeSource.youtubeChannelId ||
      safeSource.userId ||
      safeSource.id ||
      safeSource.modashId ||
      safeSource.youtube?.channelId ||
      undefined,

    title:
      safeSource.title ||
      safeSource.fullname ||
      safeSource.fullName ||
      safeSource.name ||
      safeSource.username ||
      safeSource.youtube?.title ||
      handle,

    handle,

    urlByHandle:
      safeSource.urlByHandle ||
      safeSource.url ||
      safeSource.profileUrl ||
      safeSource.youtube?.urlByHandle ||
      undefined,

    urlById:
      safeSource.urlById ||
      safeSource.channelUrl ||
      safeSource.youtube?.urlById ||
      undefined,

    description:
      safeSource.description ||
      safeSource.bio ||
      safeSource.about ||
      safeSource.youtube?.description ||
      undefined,

    country:
      safeSource.country ||
      safeSource.location?.country ||
      safeSource.youtube?.country ||
      undefined,

    subscriberCount:
      typeof safeSource.subscriberCount === "number"
        ? safeSource.subscriberCount
        : typeof safeSource.followers === "number"
          ? safeSource.followers
          : undefined,

    videoCount:
      typeof safeSource.videoCount === "number"
        ? safeSource.videoCount
        : typeof safeSource.postsCount === "number"
          ? safeSource.postsCount
          : undefined,

    viewCount:
      typeof safeSource.viewCount === "number"
        ? safeSource.viewCount
        : typeof safeSource.averageViews === "number"
          ? safeSource.averageViews
          : undefined,

    topicCategories: Array.isArray(safeSource.topicCategories)
      ? safeSource.topicCategories
      : Array.isArray(safeSource.youtube?.topicCategories)
        ? safeSource.youtube.topicCategories
        : undefined,

    topicCategoryLabels: Array.isArray(safeSource.topicCategoryLabels)
      ? safeSource.topicCategoryLabels
      : Array.isArray(safeSource.youtube?.topicCategoryLabels)
        ? safeSource.youtube.topicCategoryLabels
        : undefined,

    fetchedAt: new Date(),
  };
}

async function getBrandByMongoId(brandId) {
  if (!isObjectId(brandId)) return null;
  return Brand.findById(brandId).lean();
}

async function findEmailInModash({ handle, platform, modashUserId }) {
  const handleWithAt = String(handle || "").trim();
  const handleWithoutAt = handleWithAt.replace(/^@/, "");

  const platformRegex = new RegExp(`^${escapeRegExp(platform)}$`, "i");

  const identityOr = [];

  if (handleWithoutAt) {
    const handleRegex = new RegExp(`^@?${escapeRegExp(handleWithoutAt)}$`, "i");

    identityOr.push({ handle: handleRegex });
    identityOr.push({ username: handleRegex });
    identityOr.push({ userId: handleRegex });
  }

  if (modashUserId) {
    const modashRegex = new RegExp(`^${escapeRegExp(modashUserId)}$`, "i");

    identityOr.push({ userId: modashRegex });
    identityOr.push({ id: modashRegex });
    identityOr.push({ channelId: modashRegex });
  }

  if (!identityOr.length) {
    return {
      email: null,
      source: "missing_identity",
      doc: null,
    };
  }

  const modash = await mongoose.connection.collection("modashes").findOne({
    $and: [
      {
        $or: [{ provider: platformRegex }, { platform: platformRegex }],
      },
      {
        $or: identityOr,
      },
    ],
  });

  if (!modash) {
    return {
      email: null,
      source: "modash_not_found",
      doc: null,
    };
  }

  const directEmail = getFirstDirectEmail(
    modash.email,
    modash.businessEmail,
    modash.contactEmail,
    modash.emailTo,
    modash.proxyEmail
  );

  if (directEmail) {
    return {
      email: directEmail,
      source: "modash_direct",
      doc: modash,
    };
  }

  const contactEmail = getEmailFromContactsTypeEmail(modash.contacts);

  if (contactEmail) {
    return {
      email: contactEmail,
      source: "modash_contact",
      doc: modash,
    };
  }

  const bioEmail = extractEmailFromText(
    [
      modash.bio,
      modash.description,
      modash.about,
      modash.contactInfo,
      modash.profileDescription,
    ]
      .filter(Boolean)
      .join("\n")
  );

  if (bioEmail) {
    return {
      email: bioEmail,
      source: "modash_bio",
      doc: modash,
    };
  }

  return {
    email: null,
    source: "modash_no_email",
    doc: modash,
  };
}

async function findEmailInInfluencer({ handle, channelId, userId, email }) {
  const cleanedEmail = cleanEmail(email);
  const normalizedHandle = normalizeHandle(handle);
  const handleWithoutAt = normalizedHandle.replace(/^@/, "");
  const normalizedChannelId = String(channelId || "").trim();
  const normalizedUserId = String(userId || "").trim();

  const identityOr = [];

  if (cleanedEmail) {
    identityOr.push({ email: cleanedEmail });
    identityOr.push({ proxyEmail: cleanedEmail });
  }

  if (normalizedUserId && normalizeObjectId(normalizedUserId)) {
    identityOr.push({ _id: toObjectId(normalizedUserId) });
  }

  for (const value of [normalizedUserId, normalizedChannelId].filter(Boolean)) {
    const rx = new RegExp(`^${escapeRegExp(value)}$`, "i");

    identityOr.push({ "page1.userId": rx });
    identityOr.push({ "page2.userId": rx });
    identityOr.push({ "page3.userId": rx });

    identityOr.push({ "page1.id": rx });
    identityOr.push({ "page2.id": rx });
    identityOr.push({ "page3.id": rx });

    identityOr.push({ "page1.modashUserId": rx });
    identityOr.push({ "page2.modashUserId": rx });
    identityOr.push({ "page3.modashUserId": rx });

    identityOr.push({ "page1.channelId": rx });
    identityOr.push({ "page2.channelId": rx });
    identityOr.push({ "page3.channelId": rx });
  }

  if (handleWithoutAt) {
    const handleRx = new RegExp(`^@?${escapeRegExp(handleWithoutAt)}$`, "i");

    identityOr.push({ "page1.handle": handleRx });
    identityOr.push({ "page2.handle": handleRx });
    identityOr.push({ "page3.handle": handleRx });

    identityOr.push({ "page1.username": handleRx });
    identityOr.push({ "page2.username": handleRx });
    identityOr.push({ "page3.username": handleRx });
  }

  if (!identityOr.length) {
    return {
      email: null,
      source: "influencer_missing_identity",
      doc: null,
    };
  }

  const influencer = await InfluencerModel.findOne({
    $or: identityOr,
  }).lean();

  if (!influencer) {
    return {
      email: null,
      source: "influencer_not_found",
      doc: null,
    };
  }

  const influencerEmail =
    getFirstDirectEmail(influencer.email, influencer.proxyEmail) ||
    getDirectEmailFromMixedValue(influencer.page1) ||
    getDirectEmailFromMixedValue(influencer.page2) ||
    getDirectEmailFromMixedValue(influencer.page3);

  return {
    email: influencerEmail,
    source: influencerEmail ? "influencer_db" : "influencer_no_email",
    doc: influencer,
  };
}

async function resolveCreatorEmail({ handle, platform, modashUserId }) {
  return findEmailInModash({ handle, platform, modashUserId });
}

async function ensureMissingEmailRecord({
  handle,
  platform,
  email,
  sourceDoc,
  emailTemplate,
  brandId,
  campaignId,
  campaignName,
  campaign,
}) {
  const normalizedHandle = normalizeHandle(handle);
  const normalizedPlatform = normalizePlatform(platform);
  const cleanedEmail = cleanEmail(email);

  const channelId = String(
    sourceDoc?.channelId ||
    sourceDoc?.youtubeChannelId ||
    sourceDoc?.youtube?.channelId ||
    sourceDoc?.userId ||
    sourceDoc?.id ||
    ""
  ).trim();

  if (!HANDLE_RX.test(normalizedHandle)) return null;
  if (normalizedPlatform !== "youtube") return null;

  let doc = await MissingEmail.findOne({
    handle: normalizedHandle,
    platform: normalizedPlatform,
  });

  if (!doc && channelId) {
    doc = await MissingEmail.findOne({
      platform: normalizedPlatform,
      "youtube.channelId": channelId,
    });
  }

  const youtubePayload = buildMissingYouTubePayload(
    {
      ...sourceDoc,
      channelId,
    },
    normalizedHandle
  );

  const campaignSnapshot = buildMissingEmailCampaignSnapshot({
    brandId,
    campaignId,
    campaign,
    campaignName,
    emailTemplate,
  });

  if (!doc) {
    doc = new MissingEmail({
      email: cleanedEmail || null,
      handle: normalizedHandle,
      platform: normalizedPlatform,
      status: cleanedEmail ? "resolved" : "pending",
      youtube: youtubePayload,
      campaigns: campaignSnapshot ? [campaignSnapshot] : [],
    });

    await doc.save();
    return doc.toObject();
  }

  doc.handle = normalizedHandle;
  doc.platform = normalizedPlatform;
  doc.youtube = youtubePayload;

  if (cleanedEmail) {
    doc.email = cleanedEmail;
    doc.status = "resolved";
  } else if (!doc.email) {
    doc.status = "pending";
  }

  if (campaignSnapshot?.campaignId) {
    const campaigns = Array.isArray(doc.campaigns) ? doc.campaigns : [];

    const existingIndex = campaigns.findIndex(
      (item) => String(item.campaignId) === String(campaignSnapshot.campaignId)
    );

    if (existingIndex >= 0) {
      const oldCampaign =
        typeof campaigns[existingIndex].toObject === "function"
          ? campaigns[existingIndex].toObject()
          : campaigns[existingIndex];

      campaigns[existingIndex] = {
        ...oldCampaign,
        ...campaignSnapshot,
      };
    } else {
      campaigns.push(campaignSnapshot);
    }

    doc.campaigns = campaigns;
    doc.markModified("campaigns");
  }

  await doc.save();
  return doc.toObject();
}

async function resolveMissingEmailDoc({
  missingEmailId,
  email,
  handle,
  platform,
  channelId,
}) {
  const rawMissingEmailId = String(missingEmailId || "").trim();
  const cleanedEmail = cleanEmail(email);
  const normalizedHandle = handle ? normalizeHandle(handle) : "";
  const normalizedPlatform = normalizePlatform(platform);
  const normalizedChannelId = String(channelId || "").trim();

  let missing = null;

  if (rawMissingEmailId && normalizeObjectId(rawMissingEmailId)) {
    missing = await MissingEmail.findById(rawMissingEmailId).lean();
  }

  if (!missing && rawMissingEmailId) {
    missing = await MissingEmail.findOne({
      $or: [
        { missingEmailId: rawMissingEmailId },
        { missingId: rawMissingEmailId },
        { uuid: rawMissingEmailId },
        { publicId: rawMissingEmailId },
        { id: rawMissingEmailId },
        { "youtube.channelId": rawMissingEmailId },
      ],
    }).lean();
  }

  if (!missing && normalizedChannelId) {
    missing = await MissingEmail.findOne({
      platform: normalizedPlatform || "youtube",
      "youtube.channelId": normalizedChannelId,
    }).lean();
  }

  if (!missing && cleanedEmail) {
    missing = await MissingEmail.findOne({
      email: cleanedEmail,
    }).lean();
  }

  if (!missing && normalizedHandle) {
    const query = {
      handle: normalizedHandle,
    };

    if (normalizedPlatform) {
      query.platform = normalizedPlatform;
    }

    missing = await MissingEmail.findOne(query).lean();
  }

  return missing;
}

async function resolveInfluencerEmailFromMissingEmail({
  handle,
  platform,
  missingEmailId,
  channelId,
}) {
  const normalizedHandle = normalizeHandle(handle);
  const normalizedPlatform = normalizePlatform(platform);

  let missingEmail = null;

  if (missingEmailId) {
    missingEmail = await resolveMissingEmailDoc({
      missingEmailId,
      handle: normalizedHandle,
      platform: normalizedPlatform,
      channelId,
    });
  }

  if (!missingEmail && normalizedHandle) {
    missingEmail = await resolveMissingEmailDoc({
      handle: normalizedHandle,
      platform: normalizedPlatform,
      channelId,
    });
  }

  if (!missingEmail && normalizedHandle) {
    missingEmail = await MissingEmail.findOne({
      handle: normalizedHandle,
    }).lean();
  }

  const recipientEmail = cleanEmail(missingEmail?.email);

  return {
    missingEmail,
    recipientEmail,
  };
}

async function resolveInvitationRecipientEmail({
  req,
  handle,
  platform,
  missingEmailId,
  userId,
  modashUserId,
  emailTemplate,
}) {
  const normalizedHandle = normalizeHandle(handle);
  const normalizedPlatform = normalizePlatform(platform);
  const channelId = getRequestChannelId(req);
  const directEmail = getRequestDirectRecipientEmail(req);

  let missingEmail = await resolveMissingEmailDoc({
    missingEmailId,
    email: directEmail,
    handle: normalizedHandle,
    platform: normalizedPlatform,
    channelId,
  });

  let recipientEmail = cleanEmail(missingEmail?.email);

  if (recipientEmail) {
    return {
      missingEmail,
      recipientEmail,
      emailSource: "missing_email",
    };
  }

  const influencerResult = await findEmailInInfluencer({
    handle: normalizedHandle,
    channelId,
    userId,
    email: directEmail,
  });

  if (influencerResult.email) {
    recipientEmail = influencerResult.email;

    missingEmail = await ensureMissingEmailRecord({
      handle: normalizedHandle,
      platform: normalizedPlatform,
      email: recipientEmail,
      sourceDoc: buildRequestCreatorSource(req, {
        ...influencerResult.doc,
        channelId,
      }),
      emailTemplate,
    });

    return {
      missingEmail,
      recipientEmail,
      emailSource: influencerResult.source,
    };
  }

  const modashResult = await findEmailInModash({
    handle: normalizedHandle,
    platform: normalizedPlatform,
    modashUserId: modashUserId || channelId,
  });

  if (modashResult.email) {
    recipientEmail = modashResult.email;

    missingEmail = await ensureMissingEmailRecord({
      handle: normalizedHandle,
      platform: normalizedPlatform,
      email: recipientEmail,
      sourceDoc: buildRequestCreatorSource(req, {
        ...modashResult.doc,
        channelId,
      }),
      emailTemplate,
    });

    return {
      missingEmail,
      recipientEmail,
      emailSource: modashResult.source,
    };
  }

  if (directEmail) {
    recipientEmail = directEmail;

    missingEmail = await ensureMissingEmailRecord({
      handle: normalizedHandle,
      platform: normalizedPlatform,
      email: recipientEmail,
      sourceDoc: buildRequestCreatorSource(req, { channelId }),
      emailTemplate,
    });

    return {
      missingEmail,
      recipientEmail,
      emailSource: "request_email",
    };
  }

  return {
    missingEmail,
    recipientEmail: null,
    emailSource: "email_not_found",
  };
}

function buildEmailTags({
  brandId,
  campaignId,
  platform,
  handle,
  type = "creator-invitation",
}) {
  return [
    { Name: "type", Value: type },
    { Name: "platform", Value: platform },
    { Name: "handle", Value: handle.replace(/^@/, "") },
    { Name: "brandId", Value: brandId },
    { Name: "campaignId", Value: campaignId },
  ];
}

function normalizeAiScore(value) {
  const n = Number(value);
  if (!Number.isFinite(n)) return null;
  return Math.max(0, Math.min(100, Math.round(n)));
}

function invitationResponse(doc, refs = {}) {
  const brand = refs.brand || null;
  const campaign = refs.campaign || null;
  const missingEmail = refs.missingEmail || null;

  const brandId = toPlainId(doc.brandId);
  const campaignId = toPlainId(doc.campaignId);
  const missingEmailId = toPlainId(doc.missingEmailId);

  return {
    _id: String(doc._id),
    invitationId: doc.invitationId || null,

    handle: doc.handle,
    platform: doc.platform,
    userId: doc.userId || null,
    modashUserId: doc.modashUserId || null,

    status: doc.status,
    aiScore: doc.aiScore ?? null,
    rawAiScore: doc.rawAiScore ?? null,
    recommendationReason: doc.recommendationReason || "",
    emailTo: doc.emailTo || null,
    emailFrom: doc.emailFrom || null,
    emailSubject: doc.emailSubject || "",
    emailMessageId: doc.emailMessageId || null,
    emailSentAt: doc.emailSentAt || null,

    followUpEmailTo: doc.followUpEmailTo || null,
    followUpEmailFrom: doc.followUpEmailFrom || null,
    followUpSubject: doc.followUpSubject || "",
    followUpMessageId: doc.followUpMessageId || null,
    followUpSentAt: doc.followUpSentAt || null,
    permanentCampaignLock: Boolean(doc.permanentCampaignLock),

    brandId,
    brandName: brand?.brandName || campaign?.brandName || doc.brandName || "",
    brandEmail: brand?.email || "",
    brandIndustry: brand?.industry || "",
    brandCompanySize: brand?.companySize || "",

    campaignId,
    campaignName: campaign?.campaignTitle || doc.campaignTitle || "",

    campaign: campaign
      ? {
        _id: String(campaign._id),
        brandId: toPlainId(campaign.brandId),
        brandName: campaign.brandName || "",
        campaignTitle: campaign.campaignTitle || "",
        description: campaign.description || "",
        campaignType: campaign.campaignType || "",
        campaignCategory: campaign.campaignCategory || "",
        campaignSubcategory: campaign.campaignSubcategory || "",
        campaignBudget: campaign.campaignBudget ?? null,
        budget: campaign.budget ?? null,
        influencerBudget: campaign.influencerBudget ?? null,
        paymentType: campaign.paymentType || "",
        platformSelection: campaign.platformSelection || [],
        numberOfInfluencers: campaign.numberOfInfluencers ?? null,
        influencerTier: campaign.influencerTier || "",
        minFollowers: campaign.minFollowers ?? null,
        maxFollowers: campaign.maxFollowers ?? null,
        creatorContentLanguage: campaign.creatorContentLanguage || "",
        audienceContentLanguage: campaign.audienceContentLanguage || "",
        targetCountry: campaign.targetCountry || "",
        additionalNotes: campaign.additionalNotes || "",
        hashtags: campaign.hashtags || [],
        timeline: campaign.timeline || null,
        startAt: campaign.startAt || null,
        endAt: campaign.endAt || null,
        scheduledAt: campaign.scheduledAt || null,
        publishedAt: campaign.publishedAt || null,
        endedAt: campaign.endedAt || null,
        status: campaign.status || "",
        publishStatus: campaign.publishStatus || "",
        approvalMode: campaign.approvalMode || "",
        isFullyManaged: campaign.isFullyManaged ?? false,
        managementType: campaign.managementType || "",
        isActive: campaign.isActive ?? null,
        applicantCount: campaign.applicantCount ?? null,
        hasApplied: campaign.hasApplied ?? null,
        isDraft: campaign.isDraft ?? null,
        byAi: campaign.byAi ?? null,
        createdAt: campaign.createdAt || null,
        updatedAt: campaign.updatedAt || null,
      }
      : null,

    missingEmailId,
    email: missingEmail?.email || null,
    missingEmail: missingEmail
      ? {
        _id: String(missingEmail._id),
        missingEmailId: missingEmail.missingEmailId || null,
        email: missingEmail.email || null,
        handle: missingEmail.handle || "",
        platform: missingEmail.platform || "",
        status: missingEmail.status || "",
        youtube: missingEmail.youtube || null,
        campaigns: missingEmail.campaigns || [],
        createdByAdminId: missingEmail.createdByAdminId || null,
        createdAt: missingEmail.createdAt || null,
        updatedAt: missingEmail.updatedAt || null,
      }
      : null,

    creatorTitle:
      missingEmail?.youtube?.title || missingEmail?.handle || doc.handle || "",

    createdAt: doc.createdAt,
    updatedAt: doc.updatedAt,
  };
}

exports.createInvitation = async (req, res) => {
  try {
    const brandId = normalizeObjectId(req.body?.brandId);
    const campaignIds = normalizeCampaignIds(req.body);

    const rawHandle = String(req.body?.handle || "").trim();
    const rawPlatform = String(req.body?.platform || "").trim();
    const rawStatus = String(req.body?.status || "").trim().toLowerCase();

    const channelId = getRequestChannelId(req);
    const userId = normalizeInfluencerUserId(req.body);
    const modashUserId =
      String(req.body?.modashUserId || channelId || userId || "").trim() ||
      null;

    const aiScore = normalizeAiScore(req.body?.aiScore);
    const rawAiScore = Number.isFinite(Number(req.body?.rawAiScore))
      ? Number(req.body.rawAiScore)
      : null;

    const recommendationReason = cleanStr(
      req.body?.recommendationReason || ""
    );

    if (!brandId) {
      return res.status(400).json({
        status: "error",
        message: "Valid brand _id is required.",
      });
    }

    if (!campaignIds.length) {
      return res.status(400).json({
        status: "error",
        message: "Valid campaignId or campaignIds are required.",
      });
    }

    if (!rawHandle) {
      return res.status(400).json({
        status: "error",
        message: "handle is required.",
      });
    }

    if (!rawPlatform) {
      return res.status(400).json({
        status: "error",
        message: "platform is required.",
      });
    }

    const handle = normalizeHandle(rawHandle);

    if (!HANDLE_RX.test(handle)) {
      return res.status(400).json({
        status: "error",
        message:
          'Invalid handle. It must start with "@" and contain letters, numbers, ".", "_" or "-".',
      });
    }

    const platform = normalizePlatform(rawPlatform);

    if (!platform || !PLATFORM_ENUM.has(platform)) {
      return res.status(400).json({
        status: "error",
        message:
          "Invalid platform. Use: youtube|instagram|tiktok. Aliases: yt, ig, tt.",
      });
    }

    const status = STATUS_ENUM.has(rawStatus) ? rawStatus : "invited";

    const brand = await getBrandByMongoId(brandId);

    if (!brand) {
      return res.status(404).json({
        status: "error",
        message: "Brand not found for provided brand _id.",
      });
    }

    const campaigns = await Campaign.find({
      _id: {
        $in: campaignIds.map((id) => toObjectId(id)),
      },
      $or: [{ brandId: toObjectId(brandId) }, { brandId: String(brandId) }],
    }).lean();

    const campaignMap = new Map(
      campaigns.map((campaign) => [String(campaign._id), campaign])
    );

    const missingCampaignIds = campaignIds.filter(
      (campaignId) => !campaignMap.has(String(campaignId))
    );

    if (missingCampaignIds.length) {
      return res.status(404).json({
        status: "error",
        message: "One or more campaigns were not found for this brand.",
        missingCampaignIds,
      });
    }

    const emailTemplate = normalizeEmailTemplate(req.body, {
      brand,
      fallbackSubject: `Invitation to Collaborate - ${brand.brandName || "CollabGlam"
        }`,
    });

    if (emailTemplate?.error) {
      return res.status(400).json({
        status: "error",
        message: emailTemplate.error,
      });
    }

    const { missingEmail, recipientEmail, emailSource } =
      await resolveInvitationRecipientEmail({
        req,
        handle,
        platform,
        missingEmailId: req.body?.missingEmailId,
        userId,
        modashUserId,
        emailTemplate,
      });

    if (!recipientEmail) {
      const results = [];
      const missingRecords = [];

      let createdCount = 0;
      let existingCount = 0;
      let updatedCount = 0;

      for (const campaignId of campaignIds) {
        const campaign = campaignMap.get(String(campaignId));

        const savedMissingEmail = await ensureMissingEmailRecord({
          handle,
          platform,
          email: null,
          sourceDoc: buildRequestCreatorSource(req, {
            channelId: channelId || modashUserId || userId,
            youtubeChannelId: channelId || modashUserId || userId,
            userId: userId || modashUserId,
            modashUserId: modashUserId || userId,

            title:
              req.body?.title ||
              req.body?.creatorTitle ||
              req.body?.influencerTitle ||
              req.body?.creator?.title ||
              req.body?.influencer?.title ||
              req.body?.youtube?.title ||
              handle,

            handle,
          }),
          emailTemplate,
          brandId,
          campaignId,
          campaign,
          campaignName:
            req.body?.campaignName ||
            campaign?.campaignTitle ||
            campaign?.campaignName ||
            "",
        });

        if (
          savedMissingEmail?._id &&
          !missingRecords.some(
            (item) => String(item._id) === String(savedMissingEmail._id)
          )
        ) {
          missingRecords.push(savedMissingEmail);
        }

        let doc = await Invitation.findOne({
          brandId,
          campaignId,
          handle,
          platform,
        });

        let responseStatus = "saved";
        let changed = false;

        if (doc) {
          responseStatus = "exists";
          existingCount += 1;

          if (doc.status !== status) {
            doc.status = status;
            changed = true;
          }

          if (userId && doc.userId !== userId) {
            doc.userId = userId;
            changed = true;
          }

          if (modashUserId && doc.modashUserId !== modashUserId) {
            doc.modashUserId = modashUserId;
            changed = true;
          }

          if (aiScore !== null && doc.aiScore !== aiScore) {
            doc.aiScore = aiScore;
            changed = true;
          }

          if (rawAiScore !== null && doc.rawAiScore !== rawAiScore) {
            doc.rawAiScore = rawAiScore;
            changed = true;
          }

          if (
            recommendationReason &&
            doc.recommendationReason !== recommendationReason
          ) {
            doc.recommendationReason = recommendationReason;
            changed = true;
          }

          if (
            savedMissingEmail?._id &&
            doc.missingEmailId !== String(savedMissingEmail._id)
          ) {
            doc.missingEmailId = String(savedMissingEmail._id);
            changed = true;
          }

          if (changed) {
            await doc.save();
            updatedCount += 1;
          }
        } else {
          const payload = {
            handle,
            platform,
            brandId,
            campaignId,
            status,
            userId,
            modashUserId,
          };

          if (aiScore !== null) payload.aiScore = aiScore;
          if (rawAiScore !== null) payload.rawAiScore = rawAiScore;

          if (recommendationReason) {
            payload.recommendationReason = recommendationReason;
          }

          if (savedMissingEmail?._id) {
            payload.missingEmailId = String(savedMissingEmail._id);
          }

          doc = await Invitation.create(payload);
          createdCount += 1;
        }

        results.push({
          status: responseStatus,
          message:
            responseStatus === "exists"
              ? "Invitation already exists for this campaign and creator. MissingEmail details were updated."
              : "Invitation Send Succefully",
          emailSent: false,
          emailMeta: null,
          emailSkippedReason:
            "Influencer email is not available. Invitation saved and linked with MissingEmail.",
          data: invitationResponse(doc, {
            brand,
            campaign,
            missingEmail: savedMissingEmail,
          }),
        });
      }

      const multipleCampaigns = campaignIds.length > 1;

      return res.status(createdCount ? 201 : 202).json({
        status: "pending_email_resolution",
        message:
          "Invitation has been saved. Influencer email is not available, so campaign details and email template were saved in MissingEmail for resolution.",
        handle,
        platform,
        emailSent: false,
        emailSource,
        createdCount,
        existingCount,
        updatedCount,
        emailSentCount: 0,
        missingEmailCount: missingRecords.length,
        emailMeta: null,
        emailSkippedReason:
          "Influencer email is not available. Email was not sent.",
        data: multipleCampaigns
          ? results.map((item) => item.data)
          : results[0]?.data || null,
        missingEmails:
          missingRecords.length === 1 ? missingRecords[0] : missingRecords,
        results,
      });
    }

    const results = [];
    let createdCount = 0;
    let existingCount = 0;
    let updatedCount = 0;
    let emailSentCount = 0;

    for (const campaignId of campaignIds) {
      const campaign = campaignMap.get(String(campaignId));

      const campaignMissingEmail =
        (await ensureMissingEmailRecord({
          handle,
          platform,
          email: recipientEmail,
          sourceDoc: buildRequestCreatorSource(req, {
            ...(missingEmail || {}),
            channelId: channelId || modashUserId || userId,
            userId: userId || modashUserId,
          }),
          emailTemplate,
          brandId,
          campaignId,
          campaign,
          campaignName:
            req.body?.campaignName ||
            campaign?.campaignTitle ||
            campaign?.campaignName ||
            "",
        })) || missingEmail;

      let doc = await Invitation.findOne({
        brandId,
        campaignId,
        handle,
        platform,
      });

      let responseStatus = "saved";
      let emailSent = false;
      let emailMeta = null;
      let emailSkippedReason = null;

      if (doc) {
        responseStatus = "exists";
        existingCount += 1;

        let changed = false;

        if (doc.status !== status) {
          doc.status = status;
          changed = true;
        }

        if (userId && doc.userId !== userId) {
          doc.userId = userId;
          changed = true;
        }

        if (modashUserId && doc.modashUserId !== modashUserId) {
          doc.modashUserId = modashUserId;
          changed = true;
        }

        if (aiScore !== null && doc.aiScore !== aiScore) {
          doc.aiScore = aiScore;
          changed = true;
        }

        if (rawAiScore !== null && doc.rawAiScore !== rawAiScore) {
          doc.rawAiScore = rawAiScore;
          changed = true;
        }

        if (
          recommendationReason &&
          doc.recommendationReason !== recommendationReason
        ) {
          doc.recommendationReason = recommendationReason;
          changed = true;
        }

        if (campaignMissingEmail?._id && !doc.missingEmailId) {
          doc.missingEmailId = String(campaignMissingEmail._id);
          changed = true;
        }

        if (changed) {
          await doc.save();
          updatedCount += 1;
        }

        emailSkippedReason = "Duplicate invitation skipped for this campaign.";
      } else {
        const payload = {
          handle,
          platform,
          brandId,
          campaignId,
          status,
          userId,
          modashUserId,
        };

        if (aiScore !== null) payload.aiScore = aiScore;
        if (rawAiScore !== null) payload.rawAiScore = rawAiScore;
        if (recommendationReason) {
          payload.recommendationReason = recommendationReason;
        }

        if (campaignMissingEmail?._id) {
          payload.missingEmailId = String(campaignMissingEmail._id);
        }

        doc = await Invitation.create(payload);
        createdCount += 1;

        try {
          const sent = await sendEmail({
            to: recipientEmail,
            from: emailTemplate.from,
            subject: emailTemplate.subject,
            text: emailTemplate.text,
            html: emailTemplate.html,
            cc: emailTemplate.cc,
            bcc: emailTemplate.bcc,
            replyTo: emailTemplate.replyTo,
            attachments: emailTemplate.attachments,
            emailTags: buildEmailTags({
              brandId,
              campaignId,
              platform,
              handle,
              type: "creator-invitation",
            }),
          });

          emailSent = Boolean(sent?.messageId);

          if (emailSent) {
            emailSentCount += 1;

            doc.emailTo = recipientEmail;
            doc.emailFrom = emailTemplate.from;
            doc.emailSubject = emailTemplate.subject;
            doc.emailMessageId = sent?.messageId || null;
            doc.emailSentAt = new Date();

            if (campaignMissingEmail?._id && !doc.missingEmailId) {
              doc.missingEmailId = String(campaignMissingEmail._id);
            }

            await doc.save();
          }

          emailMeta = {
            recipientEmail,
            emailSource,
            missingEmailId: campaignMissingEmail?._id
              ? String(campaignMissingEmail._id)
              : null,
            messageId: sent?.messageId || null,
            subject: emailTemplate.subject,
            campaignId,
            from: emailTemplate.from,
          };
        } catch (mailErr) {
          console.error("Invitation AWS email send failed:", mailErr);

          emailSkippedReason =
            mailErr?.message ||
            "Invitation saved, but AWS email sending failed.";
        }
      }

      results.push({
        status: responseStatus,
        message:
          responseStatus === "exists"
            ? "Invitation already exists for this campaign and creator."
            : "Invitation created successfully.",
        emailSent,
        emailMeta,
        emailSkippedReason,
        data: invitationResponse(doc, {
          brand,
          campaign,
          missingEmail: campaignMissingEmail,
        }),
      });
    }

    const multipleCampaigns = campaignIds.length > 1;

    return res.status(createdCount ? 201 : 200).json({
      status: createdCount ? "saved" : "exists",
      message: multipleCampaigns
        ? "Invitations processed successfully."
        : createdCount
          ? "Invitation created successfully."
          : "Invitation already exists for this campaign and creator.",
      createdCount,
      existingCount,
      updatedCount,
      emailSentCount,
      emailSent: emailSentCount > 0,
      emailMeta: multipleCampaigns ? null : results[0]?.emailMeta || null,
      emailSkippedReason: multipleCampaigns
        ? null
        : results[0]?.emailSkippedReason || null,
      data: multipleCampaigns
        ? results.map((item) => item.data)
        : results[0]?.data || null,
      results,
    });
  } catch (err) {
    console.error("createInvitation error:", err);

    const statusCode =
      err?.code === 11000 ? 409 : err?.statusCode || err?.status || 500;

    await saveErrorLog(req, err, statusCode, "CREATE_INVITATION_ERROR");

    if (err?.code === 11000) {
      return res.status(409).json({
        status: "error",
        message:
          "Duplicate MongoDB index is still blocking this invitation. Drop old unique indexes from invitations collection.",
        duplicateKey: err.keyValue || null,
        indexesToDrop: [
          "brandId_1_handle_1_platform_1",
          "brandId_1_campaignId_1_handle_1_platform_1",
        ],
      });
    }

    return res.status(500).json({
      status: "error",
      message: err?.message || "Failed to create invitation.",
    });
  }
};

exports.sendInvitationFollowUp = async (req, res) => {
  try {
    const brandId = normalizeObjectId(req.body?.brandId);
    const campaignId = normalizeObjectId(req.body?.campaignId);

    const rawHandle = String(req.body?.handle || "").trim();
    const rawPlatform = String(req.body?.platform || "").trim();

    const channelId = getRequestChannelId(req);
    const userId = normalizeInfluencerUserId(req.body);
    const modashUserId =
      String(req.body?.modashUserId || channelId || userId || "").trim() ||
      null;

    if (!brandId) {
      return res.status(400).json({
        status: "error",
        message: "Valid brand _id is required.",
      });
    }

    if (!campaignId) {
      return res.status(400).json({
        status: "error",
        message: "Valid campaignId is required.",
      });
    }

    if (!rawHandle) {
      return res.status(400).json({
        status: "error",
        message: "handle is required.",
      });
    }

    if (!rawPlatform) {
      return res.status(400).json({
        status: "error",
        message: "platform is required.",
      });
    }

    const handle = normalizeHandle(rawHandle);

    if (!HANDLE_RX.test(handle)) {
      return res.status(400).json({
        status: "error",
        message:
          'Invalid handle. It must start with "@" and contain letters, numbers, ".", "_" or "-".',
      });
    }

    const platform = normalizePlatform(rawPlatform);

    if (!platform || !PLATFORM_ENUM.has(platform)) {
      return res.status(400).json({
        status: "error",
        message:
          "Invalid platform. Use: youtube|instagram|tiktok. Aliases: yt, ig, tt.",
      });
    }

    const [brand, campaign] = await Promise.all([
      getBrandByMongoId(brandId),
      Campaign.findOne({
        _id: toObjectId(campaignId),
        $or: [{ brandId: toObjectId(brandId) }, { brandId: String(brandId) }],
      }).lean(),
    ]);

    if (!brand) {
      return res.status(404).json({
        status: "error",
        message: "Brand not found for provided brand _id.",
      });
    }

    if (!campaign) {
      return res.status(404).json({
        status: "error",
        message: "Campaign not found for this brand.",
      });
    }

    const doc = await Invitation.findOne({
      brandId,
      campaignId,
      handle,
      platform,
    });

    if (!doc) {
      return res.status(404).json({
        status: "error",
        message:
          "Invitation not found. Send the invitation first before follow-up.",
      });
    }

    if (doc.permanentCampaignLock || doc.followUpSentAt) {
      return res.status(409).json({
        status: "error",
        message: "Follow-up already sent. This campaign is permanently locked.",
        data: invitationResponse(doc, { brand, campaign }),
      });
    }

    const { missingEmail, recipientEmail } =
      await resolveInfluencerEmailFromMissingEmail({
        handle,
        platform,
        missingEmailId: doc.missingEmailId || req.body?.missingEmailId,
        channelId,
      });

    if (!recipientEmail) {
      return res.status(400).json({
        status: "error",
        message:
          "Influencer email not found in MissingEmail for this handle. Please resolve the missing email first.",
        handle,
        platform,
      });
    }

    const emailTemplate = normalizeEmailTemplate(req.body, {
      brand,
      fallbackSubject: `Follow-up: Invitation to Collaborate - ${brand.brandName || "CollabGlam"
        }`,
    });

    if (emailTemplate?.error) {
      return res.status(400).json({
        status: "error",
        message: emailTemplate.error,
      });
    }

    const sent = await sendEmail({
      to: recipientEmail,
      from: emailTemplate.from,
      subject: emailTemplate.subject,
      text: emailTemplate.text,
      html: emailTemplate.html,
      cc: emailTemplate.cc,
      bcc: emailTemplate.bcc,
      replyTo: emailTemplate.replyTo,
      attachments: emailTemplate.attachments,
      emailTags: buildEmailTags({
        brandId,
        campaignId,
        platform,
        handle,
        type: "creator-followup",
      }),
    });

    doc.status = "invited";

    if (userId && doc.userId !== userId) {
      doc.userId = userId;
    }

    if (modashUserId && doc.modashUserId !== modashUserId) {
      doc.modashUserId = modashUserId;
    }

    if (missingEmail?._id) {
      doc.missingEmailId = String(missingEmail._id);
    }

    doc.followUpEmailTo = recipientEmail;
    doc.followUpEmailFrom = emailTemplate.from;
    doc.followUpSubject = emailTemplate.subject;
    doc.followUpMessageId = sent?.messageId || null;
    doc.followUpSentAt = new Date();
    doc.permanentCampaignLock = true;

    await doc.save();

    return res.status(200).json({
      status: "success",
      message: "Follow-up email sent successfully. Campaign locked permanently.",
      emailSent: Boolean(sent?.messageId),
      emailMeta: {
        recipientEmail,
        emailSource: "missing_email",
        missingEmailId: missingEmail?._id ? String(missingEmail._id) : null,
        messageId: sent?.messageId || null,
        subject: emailTemplate.subject,
        from: emailTemplate.from,
        campaignId,
      },
      data: invitationResponse(doc, {
        brand,
        campaign,
        missingEmail,
      }),
    });
  } catch (err) {
    console.error("sendInvitationFollowUp error:", err);

    const statusCode = err?.statusCode || err?.status || 500;

    await saveErrorLog(req, err, statusCode, "SEND_INVITATION_FOLLOWUP_ERROR");

    return res.status(500).json({
      status: "error",
      message: err?.message || "Failed to send follow-up email.",
    });
  }
};

exports.updateInvitationStatus = async (req, res) => {
  try {
    const invitationId = normalizeObjectId(
      req.body?._id || req.body?.invitationId
    );
    const rawStatus = String(req.body?.status || "").trim().toLowerCase();

    if (!invitationId) {
      return res.status(400).json({
        status: "error",
        message: "Valid invitation _id is required.",
      });
    }

    if (!STATUS_ENUM.has(rawStatus)) {
      return res.status(400).json({
        status: "error",
        message: 'Invalid status. Use "invited" or "available".',
      });
    }

    const doc = await Invitation.findById(invitationId);

    if (!doc) {
      return res.status(404).json({
        status: "error",
        message: "Invitation not found for provided _id.",
      });
    }

    doc.status = rawStatus;

    const userId = normalizeInfluencerUserId(req.body);

    if (userId) {
      doc.userId = userId;
    }

    let warning = null;

    const rawMissingEmailId = String(req.body?.missingEmailId || "").trim();
    const hasResolverInput =
      rawMissingEmailId ||
      req.body?.email ||
      req.body?.handle ||
      req.body?.platform ||
      req.body?.channelId ||
      req.body?.youtubeChannelId;

    if (hasResolverInput) {
      const missing = await resolveMissingEmailDoc({
        missingEmailId: rawMissingEmailId,
        email: req.body?.email,
        handle: req.body?.handle || doc.handle,
        platform: req.body?.platform || doc.platform,
        channelId: getRequestChannelId(req),
      });

      if (missing?._id) {
        doc.missingEmailId = String(missing._id);
      } else if (rawMissingEmailId) {
        warning =
          "missingEmailId was not found as Mongo _id or custom id, so status was updated without changing invitation.missingEmailId.";
      }
    }

    await doc.save();

    const [brand, campaign, missingEmail] = await Promise.all([
      doc.brandId ? Brand.findById(doc.brandId).lean() : null,
      doc.campaignId ? Campaign.findById(doc.campaignId).lean() : null,
      doc.missingEmailId
        ? resolveMissingEmailDoc({ missingEmailId: doc.missingEmailId })
        : null,
    ]);

    return res.json({
      status: "success",
      message: warning
        ? "Invitation status updated, but missing email could not be linked."
        : "Invitation status updated.",
      warning,
      data: invitationResponse(doc, { brand, campaign, missingEmail }),
    });
  } catch (err) {
    console.error("Error in updateInvitationStatus:", err);
    await saveErrorLog(
      req,
      err,
      err?.statusCode || err?.status || 500,
      "UPDATE_INVITATION_STATUS_ERROR"
    );

    return res.status(500).json({
      status: "error",
      message: err?.message || "Internal server error.",
    });
  }
};

exports.listInvitations = async (req, res) => {
  try {
    const body = {
      ...(req.query || {}),
      ...(req.body || {}),
    };

    const page = Math.max(1, parseInt(body.page ?? "1", 10));
    const limit = Math.min(200, Math.max(1, parseInt(body.limit ?? "50", 10)));

    const brandId = body.brandId ? normalizeObjectId(body.brandId) : "";
    const campaignId = body.campaignId ? normalizeObjectId(body.campaignId) : "";
    const campaignIds = Array.isArray(body.campaignIds)
      ? body.campaignIds.map((id) => normalizeObjectId(id)).filter(Boolean)
      : [];

    const userId = String(
      body.userId ||
      body.influencerUserId ||
      body.creatorId ||
      body.influencerId ||
      ""
    ).trim();

    const rawHandle = typeof body.handle === "string" ? body.handle.trim() : "";
    const rawPlatform =
      typeof body.platform === "string" ? body.platform.trim() : "";
    const rawStatus =
      typeof body.status === "string" ? body.status.trim().toLowerCase() : "";
    const rawSearch =
      typeof body.search === "string" ? body.search.trim() : "";

    const missingEmailOnly =
      body.missingEmailOnly === true ||
      body.missingEmailOnly === "true" ||
      body.onlyMissingEmail === true ||
      body.onlyMissingEmail === "true";

    const query = {};

    if (body.brandId) {
      if (!brandId) {
        return res.status(400).json({
          status: "error",
          message: "Invalid brandId. Use brand _id.",
        });
      }

      query.brandId = brandId;
    }

    if (body.campaignId) {
      if (!campaignId) {
        return res.status(400).json({
          status: "error",
          message: "Invalid campaignId. Use campaign _id.",
        });
      }

      query.campaignId = campaignId;
    }

    if (body.campaignIds) {
      if (!campaignIds.length) {
        return res.status(400).json({
          status: "error",
          message: "Invalid campaignIds. Use campaign _id array.",
        });
      }

      query.campaignId = { $in: campaignIds };
    }

    if (userId) {
      query.userId = userId;
    }

    if (rawHandle) {
      const handle = normalizeHandle(rawHandle);

      if (!HANDLE_RX.test(handle)) {
        return res.status(400).json({
          status: "error",
          message: "Invalid handle format in filter.",
        });
      }

      query.handle = handle;
    }

    if (rawPlatform) {
      const platform = normalizePlatform(rawPlatform);

      if (!platform) {
        return res.status(400).json({
          status: "error",
          message:
            "Invalid platform filter. Use: youtube|instagram|tiktok. Aliases: yt, ig, tt.",
        });
      }

      query.platform = platform;
    }

    if (rawStatus && rawStatus !== "all") {
      if (!STATUS_ENUM.has(rawStatus)) {
        return res.status(400).json({
          status: "error",
          message: 'Invalid status filter. Use "invited", "available" or "all".',
        });
      }

      query.status = rawStatus;
    }

    if (missingEmailOnly) {
      query.missingEmailId = {
        $exists: true,
        $nin: [null, ""],
      };
    }

    if (rawSearch) {
      const rx = new RegExp(escapeRegExp(rawSearch), "i");

      const [matchedBrands, matchedCampaigns, matchedMissingEmails] =
        await Promise.all([
          Brand.find({
            $or: [
              { brandName: rx },
              { email: rx },
              { name: rx },
              { industry: rx },
              { companySize: rx },
            ],
          })
            .select("_id")
            .lean(),

          Campaign.find({
            $or: [
              { campaignTitle: rx },
              { brandName: rx },
              { description: rx },
              { campaignType: rx },
              { campaignCategory: rx },
              { campaignSubcategory: rx },
              { targetCountry: rx },
              { paymentType: rx },
              { influencerTier: rx },
              { hashtags: rx },
            ],
          })
            .select("_id")
            .lean(),

          MissingEmail.find({
            $or: [
              { email: rx },
              { handle: rx },
              { platform: rx },
              { status: rx },
              { "youtube.title": rx },
              { "youtube.description": rx },
              { "youtube.country": rx },
              { "youtube.channelId": rx },
              { "campaigns.campaignName": rx },
            ],
          })
            .select("_id")
            .lean(),
        ]);

      const matchedBrandIds = matchedBrands.map((item) => String(item._id));
      const matchedCampaignIds = matchedCampaigns.map((item) =>
        String(item._id)
      );
      const matchedMissingEmailIds = matchedMissingEmails.map((item) =>
        String(item._id)
      );

      const searchOr = [
        { handle: rx },
        { userId: rx },
        { modashUserId: rx },
        { recommendationReason: rx },
      ];

      const possibleHandle = normalizeHandle(rawSearch);

      if (HANDLE_RX.test(possibleHandle)) {
        searchOr.push({ handle: possibleHandle });
      }

      if (isObjectId(rawSearch)) {
        searchOr.push({ _id: toObjectId(rawSearch) });
        searchOr.push({ brandId: rawSearch });
        searchOr.push({ campaignId: rawSearch });
        searchOr.push({ missingEmailId: rawSearch });
      }

      if (matchedBrandIds.length) {
        searchOr.push({ brandId: { $in: matchedBrandIds } });
      }

      if (matchedCampaignIds.length) {
        searchOr.push({ campaignId: { $in: matchedCampaignIds } });
      }

      if (matchedMissingEmailIds.length) {
        searchOr.push({ missingEmailId: { $in: matchedMissingEmailIds } });
      }

      query.$or = searchOr;
    }

    const [total, docs] = await Promise.all([
      Invitation.countDocuments(query),
      Invitation.find(query)
        .sort({ createdAt: -1 })
        .skip((page - 1) * limit)
        .limit(limit)
        .lean(),
    ]);

    const brandIds = [
      ...new Set(
        docs.map((doc) => normalizeObjectId(doc.brandId)).filter(Boolean)
      ),
    ];

    const foundCampaignIds = [
      ...new Set(
        docs.map((doc) => normalizeObjectId(doc.campaignId)).filter(Boolean)
      ),
    ];

    const rawMissingEmailIds = [
      ...new Set(
        docs
          .map((doc) => String(doc.missingEmailId || "").trim())
          .filter(Boolean)
      ),
    ];

    const mongoMissingEmailIds = rawMissingEmailIds.filter((id) =>
      normalizeObjectId(id)
    );

    const customMissingEmailIds = rawMissingEmailIds.filter(
      (id) => !normalizeObjectId(id)
    );

    const [brands, campaigns, missingEmails] = await Promise.all([
      brandIds.length
        ? Brand.find({
          _id: { $in: brandIds.map((id) => toObjectId(id)) },
        })
          .select(
            [
              "brandName",
              "email",
              "name",
              "industry",
              "companySize",
              "proxyEmail",
              "subscription",
              "subscriptionExpired",
              "isAdminCreated",
              "signupCompleted",
              "createdAt",
              "updatedAt",
            ].join(" ")
          )
          .lean()
        : [],

      foundCampaignIds.length
        ? Campaign.find({
          _id: { $in: foundCampaignIds.map((id) => toObjectId(id)) },
        })
          .select(
            [
              "brandId",
              "brandName",
              "campaignTitle",
              "description",
              "campaignType",
              "campaignCategory",
              "campaignSubcategory",
              "campaignBudget",
              "budget",
              "influencerBudget",
              "paymentType",
              "platformSelection",
              "numberOfInfluencers",
              "influencerTier",
              "minFollowers",
              "maxFollowers",
              "creatorContentLanguage",
              "audienceContentLanguage",
              "targetCountry",
              "additionalNotes",
              "hashtags",
              "timeline",
              "startAt",
              "endAt",
              "scheduledAt",
              "publishedAt",
              "endedAt",
              "status",
              "publishStatus",
              "approvalMode",
              "isFullyManaged",
              "managementType",
              "isActive",
              "applicantCount",
              "hasApplied",
              "isDraft",
              "byAi",
              "createdAt",
              "updatedAt",
            ].join(" ")
          )
          .lean()
        : [],

      rawMissingEmailIds.length
        ? MissingEmail.find({
          $or: [
            ...(mongoMissingEmailIds.length
              ? [
                {
                  _id: {
                    $in: mongoMissingEmailIds.map((id) => toObjectId(id)),
                  },
                },
              ]
              : []),
            ...(customMissingEmailIds.length
              ? [
                { missingEmailId: { $in: customMissingEmailIds } },
                { missingId: { $in: customMissingEmailIds } },
                { uuid: { $in: customMissingEmailIds } },
                { publicId: { $in: customMissingEmailIds } },
                { id: { $in: customMissingEmailIds } },
              ]
              : []),
          ],
        }).lean()
        : [],
    ]);

    const brandMap = new Map(brands.map((brand) => [String(brand._id), brand]));

    const campaignMap = new Map(
      campaigns.map((campaign) => [String(campaign._id), campaign])
    );

    const missingEmailMap = new Map();

    for (const missing of missingEmails) {
      missingEmailMap.set(String(missing._id), missing);

      for (const key of [
        "missingEmailId",
        "missingId",
        "uuid",
        "publicId",
        "id",
      ]) {
        if (missing[key]) {
          missingEmailMap.set(String(missing[key]), missing);
        }
      }
    }

    const data = docs.map((doc) =>
      invitationResponse(doc, {
        brand: brandMap.get(String(doc.brandId || "")),
        campaign: campaignMap.get(String(doc.campaignId || "")),
        missingEmail: missingEmailMap.get(String(doc.missingEmailId || "")),
      })
    );

    return res.json({
      status: "success",
      message: docs.length
        ? "Invitation list fetched successfully."
        : missingEmailOnly
          ? "No invitations found with missingEmailId."
          : "No invitations found.",
      page,
      limit,
      total,
      hasNext: page * limit < total,
      data,
    });
  } catch (err) {
    console.error("listInvitations error:", err);

    await saveErrorLog(
      req,
      err,
      err?.statusCode || err?.status || 500,
      "LIST_INVITATIONS_ERROR"
    );

    return res.status(500).json({
      status: "error",
      message: err?.message || "Internal server error.",
    });
  }
};

exports.getInvitationList = async (req, res) => {
  try {
    const brandId =
      normalizeObjectId(req.body?.brandId) ||
      normalizeObjectId(req.query?.brandId);

    if (!brandId) {
      return res.status(400).json({
        status: "error",
        message: "Valid brand _id is required.",
      });
    }

    const invitations = await Invitation.find({
      brandId,
      missingEmailId: { $ne: null },
    }).lean();

    if (!invitations.length) {
      return res.json({
        status: "success",
        message: "No invitations found for this brand with missingEmailId.",
        data: [],
      });
    }

    const missingIds = [
      ...new Set(
        invitations
          .map((inv) => String(inv.missingEmailId || "").trim())
          .filter(Boolean)
      ),
    ];

    const mongoMissingIds = missingIds.filter((id) => normalizeObjectId(id));
    const customMissingIds = missingIds.filter((id) => !normalizeObjectId(id));

    const campaignIds = [
      ...new Set(
        invitations
          .map((inv) => normalizeObjectId(inv.campaignId))
          .filter(Boolean)
      ),
    ];

    const [missingDocs, campaigns] = await Promise.all([
      missingIds.length
        ? MissingEmail.find({
          $or: [
            ...(mongoMissingIds.length
              ? [
                {
                  _id: {
                    $in: mongoMissingIds.map((id) => toObjectId(id)),
                  },
                },
              ]
              : []),
            ...(customMissingIds.length
              ? [
                { missingEmailId: { $in: customMissingIds } },
                { missingId: { $in: customMissingIds } },
                { uuid: { $in: customMissingIds } },
                { publicId: { $in: customMissingIds } },
                { id: { $in: customMissingIds } },
              ]
              : []),
          ],
        }).lean()
        : [],
      campaignIds.length
        ? Campaign.find({
          _id: {
            $in: campaignIds.map((id) => toObjectId(id)),
          },
        })
          .select("campaignTitle brandName campaignBudget status publishStatus")
          .lean()
        : [],
    ]);

    const missingMap = new Map();
    const campaignMap = new Map();

    for (const me of missingDocs) {
      missingMap.set(String(me._id), me);

      for (const key of [
        "missingEmailId",
        "missingId",
        "uuid",
        "publicId",
        "id",
      ]) {
        if (me[key]) {
          missingMap.set(String(me[key]), me);
        }
      }
    }

    for (const campaign of campaigns) {
      campaignMap.set(String(campaign._id), campaign);
    }

    const data = invitations.map((inv) => {
      const me = missingMap.get(String(inv.missingEmailId || ""));
      const campaign = campaignMap.get(String(inv.campaignId || ""));

      const title = me?.youtube?.title || me?.handle || inv.handle || "";

      return {
        _id: String(inv._id),
        invitationId: inv.invitationId || null,
        handle: inv.handle || "",
        platform: inv.platform || "",
        userId: inv.userId || null,
        modashUserId: inv.modashUserId || null,
        status: inv.status || "",
        missingEmailId: inv.missingEmailId || null,
        campaignId: inv.campaignId || null,
        campaignName: campaign?.campaignTitle || "",
        brandName: campaign?.brandName || "",
        title,
        email: me?.email || null,
        missingEmail: me || null,
      };
    });

    return res.json({
      status: "success",
      message: "Invitation list fetched successfully.",
      data,
    });
  } catch (err) {
    console.error("Error in getInvitationList:", err);
    await saveErrorLog(
      req,
      err,
      err?.statusCode || err?.status || 500,
      "GET_INVITATION_LIST_ERROR"
    );

    return res.status(500).json({
      status: "error",
      message: "Internal server error.",
    });
  }
};

const COOLDOWN_MS = 48 * 60 * 60 * 1000;

async function computeBrandEligibilityForThread(threadId) {
  const messages = await EmailMessage.find({ thread: threadId })
    .select("direction createdAt sentAt")
    .sort({ createdAt: 1 })
    .lean();

  const hasIncoming = messages.some(
    (m) => m.direction === "influencer_to_brand"
  );

  if (hasIncoming) {
    return {
      canSend: true,
      state: "allowed",
      reason: "Influencer replied — messaging is unlocked.",
      nextAllowedAt: null,
      outgoingCount: messages.filter(
        (m) => m.direction === "brand_to_influencer"
      ).length,
    };
  }

  const outgoing = messages.filter(
    (m) => m.direction === "brand_to_influencer"
  );
  const outgoingCount = outgoing.length;

  if (outgoingCount === 0) {
    return {
      canSend: true,
      state: "allowed",
      reason: "First email allowed.",
      nextAllowedAt: null,
      outgoingCount,
    };
  }

  if (outgoingCount === 1) {
    const firstAt = new Date(
      outgoing[0].sentAt || outgoing[0].createdAt
    ).getTime();
    const nextAllowedAt = new Date(firstAt + COOLDOWN_MS);

    if (Date.now() >= nextAllowedAt.getTime()) {
      return {
        canSend: true,
        state: "allowed",
        reason: "48 hours passed — follow-up allowed.",
        nextAllowedAt: null,
        outgoingCount,
      };
    }

    return {
      canSend: false,
      state: "cooldown",
      reason: "Wait 48 hours before sending a follow-up. No reply yet.",
      nextAllowedAt: nextAllowedAt.toISOString(),
      outgoingCount,
    };
  }

  return {
    canSend: false,
    state: "blocked",
    reason:
      "You already sent 2 emails without a reply. You can message again only after the influencer replies.",
    nextAllowedAt: null,
    outgoingCount,
  };
}

exports.getInvitationSendEligibility = async (req, res) => {
  try {
    const brandId = normalizeObjectId(req.body?.brandId);
    const invitationId = normalizeObjectId(
      req.body?._id || req.body?.invitationId
    );

    if (!brandId || !invitationId) {
      return res.status(400).json({
        canSend: false,
        state: "missing_email",
        reason: "brandId and invitation _id are required.",
        nextAllowedAt: null,
      });
    }

    const brand = await Brand.findById(brandId).lean();

    if (!brand) {
      return res.status(404).json({
        canSend: false,
        state: "missing_email",
        reason: "Brand not found.",
        nextAllowedAt: null,
      });
    }

    const invitation = await Invitation.findById(invitationId).lean();

    if (!invitation) {
      return res.status(404).json({
        canSend: false,
        state: "missing_email",
        reason: "Invitation not found.",
        nextAllowedAt: null,
      });
    }

    if (invitation.brandId && invitation.brandId !== String(brand._id)) {
      return res.status(403).json({
        canSend: false,
        state: "missing_email",
        reason: "Invitation does not belong to this brand.",
        nextAllowedAt: null,
      });
    }

    if (!invitation.missingEmailId) {
      return res.status(200).json({
        canSend: false,
        state: "missing_email",
        reason: "No missing email record exists for this invitation.",
        nextAllowedAt: null,
        threadId: null,
      });
    }

    const missing = await resolveMissingEmailDoc({
      missingEmailId: invitation.missingEmailId,
    });

    const recipientEmail = cleanEmail(missing?.email);

    if (!recipientEmail) {
      return res.status(200).json({
        canSend: false,
        state: "missing_email",
        reason: "Recipient email not found yet for this invitation.",
        nextAllowedAt: null,
        threadId: null,
      });
    }

    const influencer = await InfluencerModel.findOne({
      email: recipientEmail,
    })
      .select("_id")
      .lean();

    if (!influencer) {
      return res.status(200).json({
        canSend: true,
        state: "allowed",
        reason: "First email allowed.",
        nextAllowedAt: null,
        threadId: null,
        outgoingCount: 0,
      });
    }

    const thread = await EmailThread.findOne({
      brand: brand._id,
      influencer: influencer._id,
    })
      .select("_id")
      .lean();

    if (!thread) {
      return res.status(200).json({
        canSend: true,
        state: "allowed",
        reason: "First email allowed.",
        nextAllowedAt: null,
        threadId: null,
        outgoingCount: 0,
      });
    }

    const eligibility = await computeBrandEligibilityForThread(thread._id);

    return res.status(200).json({
      ...eligibility,
      threadId: String(thread._id),
    });
  } catch (err) {
    console.error("getInvitationSendEligibility error:", err);
    await saveErrorLog(
      req,
      err,
      err?.statusCode || err?.status || 500,
      "GET_INVITATION_SEND_ELIGIBILITY_ERROR"
    );

    return res.status(500).json({
      canSend: false,
      state: "missing_email",
      reason: "Internal server error.",
      nextAllowedAt: null,
    });
  }
};

module.exports.resolveCreatorEmail = resolveCreatorEmail;