const mongoose = require("mongoose");
const { Schema, model } = mongoose;

const WalletTopupSchema = new Schema(
  {
    amount: { type: Number, required: true, min: 0 },
    currency: { type: String, default: "usd", lowercase: true },

    status: {
      type: String,
      enum: ["success", "pending", "failed"],
      default: "success",
      index: true,
    },

    source: {
      type: String,
      enum: ["stripe", "admin_manual"],
      default: "stripe",
    },

    stripeSessionId: { type: String, default: null, index: true },
    stripePaymentIntentId: { type: String, default: null },
    paymentIntentId: { type: String, default: null },

    walletBalanceBefore: { type: Number, default: 0, min: 0 },
    walletBalanceAfter: { type: Number, default: 0, min: 0 },

    note: { type: String, default: "" },

    addedByAdminId: { type: String, default: null },
    addedByAdminEmail: { type: String, default: null },

    createdAt: { type: Date, default: Date.now },
  },
  { _id: false }
);

const EscrowHistorySchema = new Schema(
  {
    brandId: { type: String, required: true, index: true },

    type: {
      type: String,
      enum: [
        "milestone_escrow",
        "milestone_escrow_adjustment",
        "milestone_escrow_refund",
        "milestone_release",
        "manual_escrow",
      ],
      default: "milestone_escrow",
      index: true,
    },

    amount: { type: Number, required: true, min: 0 },
    currency: { type: String, default: "usd", lowercase: true },

    // These are audit/reference fields only. Wallet balance is no longer split by campaign.
    campaignId: { type: String, default: "", index: true },
    influencerId: { type: String, default: "", index: true },
    contractId: { type: String, default: "" },
    milestoneId: { type: String, default: "" },
    milestoneHistoryId: { type: String, default: "" },
    milestoneTitle: { type: String, default: "" },

    walletBalanceBefore: { type: Number, default: 0, min: 0 },
    walletBalanceAfter: { type: Number, default: 0, min: 0 },

    escrowBalanceBefore: { type: Number, default: 0, min: 0 },
    escrowBalanceAfter: { type: Number, default: 0, min: 0 },

    note: { type: String, default: "" },

    createdAt: { type: Date, default: Date.now },
  },
  { _id: false }
);

const WithdrawHistorySchema = new Schema(
  {
    brandId: { type: String, required: true, index: true },

    amount: { type: Number, required: true, min: 0 },
    currency: { type: String, default: "usd", lowercase: true },

    status: {
      type: String,
      enum: ["success", "pending", "failed"],
      default: "success",
      index: true,
    },

    method: {
      type: String,
      enum: ["manual", "bank", "upi", "stripe", "razorpayx"],
      default: "manual",
    },

    transactionId: { type: String, default: null },

    walletBalanceBefore: { type: Number, default: 0, min: 0 },
    walletBalanceAfter: { type: Number, default: 0, min: 0 },

    note: { type: String, default: "" },

    createdAt: { type: Date, default: Date.now },
  },
  { _id: false }
);

const BrandWalletSchema = new Schema(
  {
    brandId: { type: String, required: true, unique: true, index: true },

    // Available wallet balance. This is the amount Brand can still use for new milestones.
    walletBalance: { type: Number, default: 0, min: 0 },

    // Escrow balance. Money moves here immediately when a milestone is created.
    escrowBalance: { type: Number, default: 0, min: 0 },

    // Backward-compatible alias for older UI/API code that reads frozenBalance.
    frozenBalance: { type: Number, default: 0, min: 0 },

    topups: { type: [WalletTopupSchema], default: [] },
    escrowHistories: { type: [EscrowHistorySchema], default: [] },
    withdrawHistories: { type: [WithdrawHistorySchema], default: [] },

    // Legacy fields kept only so old documents/routes do not crash during migration.
    freezes: { type: [Schema.Types.Mixed], default: [] },
    freezeHistories: { type: [Schema.Types.Mixed], default: [] },
    allocationHistories: { type: [Schema.Types.Mixed], default: [] },
  },
  { timestamps: true }
);

BrandWalletSchema.pre("validate", function syncLegacyFrozenBalance(next) {
  const escrowBalance = Number(this.escrowBalance || this.frozenBalance || 0);
  this.escrowBalance = Math.max(0, escrowBalance);
  this.frozenBalance = this.escrowBalance;
  this.walletBalance = Math.max(0, Number(this.walletBalance || 0));
  next();
});

BrandWalletSchema.index({ brandId: 1 });
BrandWalletSchema.index({ brandId: 1, "topups.stripeSessionId": 1 });
BrandWalletSchema.index({ brandId: 1, "escrowHistories.type": 1 });
BrandWalletSchema.index({ brandId: 1, "escrowHistories.milestoneHistoryId": 1 });
BrandWalletSchema.index({ brandId: 1, "escrowHistories.influencerId": 1 });

const BrandWalletModel = model("BrandWallet", BrandWalletSchema);

module.exports = { BrandWalletModel };