const mongoose = require("mongoose");
const { v4: uuidv4 } = require("uuid");

const EMAIL_RX = /^[A-Za-z0-9._%+\-]+@[A-Za-z0-9.\-]+\.[A-Za-z]{2,}$/;
const HANDLE_RX = /^@[A-Za-z0-9._\-]+$/;

const PLATFORM_ENUM = ["youtube"];

const MissingEmailCampaignSchema = new mongoose.Schema(
  {
    brandId: {
      type: String,
      default: null,
      index: true,
      ref: "Brand",
    },

    campaignId: {
      type: String,
      default: null,
      index: true,
      ref: "Campaign",
    },

    campaignName: {
      type: String,
      default: "",
      trim: true,
    },

    handle: {
      type: String,
      required: [true, "Handle is required"],
      lowercase: true,
      trim: true,
      set: (v) => {
        if (!v) return v;
        const t = String(v).trim().toLowerCase();
        return t.startsWith("@") ? t : `@${t}`;
      },
      validate: {
        validator: (v) => HANDLE_RX.test(v || ""),
        message:
          'Handle must start with "@" and contain letters, numbers, ".", "_" or "-"',
      },
    },

    platform: {
      type: String,
      required: true,
      lowercase: true,
      trim: true,
      enum: {
        values: PLATFORM_ENUM,
        message: "Platform must be youtube",
      },
      default: "youtube",
    },

    channelId: {
      type: String,
      default: null,
      trim: true,
      index: true,
    },

    requestedAt: {
      type: Date,
      default: Date.now,
    },
  },
  { _id: false }
);

const MissingEmailSchema = new mongoose.Schema(
  {
    missingEmailId: {
      type: String,
      required: true,
      unique: true,
      default: uuidv4,
      index: true,
    },

    email: {
      type: String,
      required: false,
      lowercase: true,
      trim: true,
      default: null,
      validate: {
        validator: (v) => !v || EMAIL_RX.test(v),
        message: "Invalid email address",
      },
    },

    handle: {
      type: String,
      required: [true, "Handle is required"],
      lowercase: true,
      trim: true,
      set: (v) => {
        if (!v) return v;
        const t = String(v).trim().toLowerCase();
        return t.startsWith("@") ? t : `@${t}`;
      },
      validate: {
        validator: (v) => HANDLE_RX.test(v || ""),
        message:
          'Handle must start with "@" and contain letters, numbers, ".", "_" or "-"',
      },
    },

    platform: {
      type: String,
      required: true,
      lowercase: true,
      trim: true,
      enum: {
        values: PLATFORM_ENUM,
        message: "Platform must be youtube",
      },
      default: "youtube",
    },

    channelId: {
      type: String,
      default: null,
      trim: true,
      index: true,
    },

    status: {
      type: String,
      enum: ["pending", "resolved"],
      default: "pending",
      index: true,
    },

    campaigns: {
      type: [MissingEmailCampaignSchema],
      default: [],
    },

    createdByAdminId: {
      type: String,
      index: true,
      default: null,
      ref: "Admin",
    },
  },
  { timestamps: true }
);

MissingEmailSchema.index({ handle: 1, platform: 1 }, { unique: true });
MissingEmailSchema.index({ email: 1 }, { sparse: true });
MissingEmailSchema.index({ channelId: 1 }, { sparse: true });
MissingEmailSchema.index({ createdAt: -1 });
MissingEmailSchema.index({ handle: 1, "campaigns.campaignId": 1 });
MissingEmailSchema.index({ channelId: 1, "campaigns.campaignId": 1 });
MissingEmailSchema.index({ "campaigns.brandId": 1, "campaigns.campaignId": 1 });
MissingEmailSchema.index({ "campaigns.channelId": 1 });

module.exports =
  mongoose.models.MissingEmail ||
  mongoose.model("MissingEmail", MissingEmailSchema);