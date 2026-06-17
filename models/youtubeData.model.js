'use strict';

const mongoose = require('mongoose');

const recentVideoSchema = new mongoose.Schema(
  {
    videoId: String,
    title: String,
    description: String,
    url: String,
    thumbnail: String,
    publishedAt: Date,
    views: { type: Number, default: 0 },
    likes: { type: Number, default: 0 },
    comments: { type: Number, default: 0 },
  },
  { _id: false }
);

const contactSchema = new mongoose.Schema(
  {
    emails: [String],
    socials: [String],
    websites: [String],
    sponsors: [String],
    otherLinks: [String],
    instagram: String,
    twitter: String,
    facebook: String,
    linkedin: String,
    website: String,
    youtubeAboutEmail: String,
    totalEmails: [String],
  },
  { _id: false }
);

const scoresSchema = new mongoose.Schema(
  {
    sponsorshipScore: { type: Number, default: 0 },
    engagementScore: { type: Number, default: 0 },
    consistencyScore: { type: Number, default: 0 },
    brandSafetyScore: { type: Number, default: 90 },
    relevancyScore: { type: Number, default: 0 },
    authenticityScore: { type: Number, default: 85 },
    audienceCountryConfidence: { type: Number, default: 0 },
    shortlistScore: { type: Number, default: 0 },
    nicheFit: { type: Number, default: 0 },
  },
  { _id: false }
);

const campaignContextSchema = new mongoose.Schema(
  {
    campaignId: String,
    campaignName: String,
    campaignNiche: String,
    campaignProduct: String,
    campaignCountry: String,
    foundViaQuery: String,
    sourceVideoTitle: String,
    sourceVideoUrl: String,
    allSearchKeywordsUsed: [String],
  },
  { _id: false }
);

const shortlistSchema = new mongoose.Schema(
  {
    nicheFit: { type: Number, default: 0 },
    contentQuality: String,
    previousSponsors: String,
    uploadFrequency: String,
    countryMatch: String,
    score: { type: Number, default: 0 },
    status: String,
    filterFailureReason: String,
  },
  { _id: false }
);

const youtubeDataSchema = new mongoose.Schema(
  {
    channelId: { type: String, required: true, unique: true, index: true },
    channelName: { type: String, index: true },
    channelUrl: String,
    thumbnail: String,

    sourceVideoTitle: String,
    sourceVideoUrl: String,
    foundViaQuery: String,
    allSearchKeywordsUsed: [String],

    subscribers: { type: Number, default: 0, index: true },
    country: { type: String, default: '', index: true },
    estimatedAudienceCountry: { type: String, default: '' },
    primaryLanguage: { type: String, default: '' },

    totalVideos: { type: Number, default: 0 },
    totalViews: { type: Number, default: 0 },
    avgViews: { type: Number, default: 0, index: true },
    avgLikes: { type: Number, default: 0 },
    avgComments: { type: Number, default: 0 },
    engagementRate: { type: Number, default: 0, index: true },

    recentUploadDate: Date,
    createdDate: Date,
    yearsOnYouTube: { type: Number, default: 0 },
    uploadFrequency30Days: { type: Number, default: 0 },
    uploadFrequency90Days: { type: Number, default: 0 },

    category: { type: String, default: '', index: true },
    channelCategory: { type: String, default: '', index: true },
    contentFlag: { type: String, default: 'Original', index: true },
    description: String,
    channelTags: [String],

    recentVideos: [recentVideoSchema],
    topVideos: [recentVideoSchema],
    contact: contactSchema,
    scores: scoresSchema,
    shortlist: shortlistSchema,

    campaignContexts: [campaignContextSchema],
    lastCampaignId: String,
    lastFetchedAt: Date,
  },
  { timestamps: true }
);

youtubeDataSchema.index({
  channelName: 'text',
  description: 'text',
  category: 'text',
  channelCategory: 'text',
  channelTags: 'text',
});

module.exports = mongoose.model('YouTubeData', youtubeDataSchema);