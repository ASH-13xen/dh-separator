import mongoose from 'mongoose';

// Persists user customizations (topic order/renames, question order, included/excluded
// questions, topper selections, topper detail overrides) for one (subject, paper) pair, so
// the PSIR book and every generic subject book look the same no matter where/when the page
// is reopened. 'subject' is the literal string 'psir' for the PSIR section, or a Subject
// slug for the generic pipeline. Keys inside the Mixed maps (topicRenames, questionOrder,
// topperOverrides) are always the CSV-derived topic title / topper URL, never a display
// value, so they stay stable across renames.
const BookLayoutSchema = new mongoose.Schema({
  subject: { type: String, required: true },
  paper: { type: String, required: true },
  topicOrder: { type: [String], default: [] },
  topicRenames: { type: mongoose.Schema.Types.Mixed, default: {} },
  expandedTopics: { type: [String], default: [] },
  questionOrder: { type: mongoose.Schema.Types.Mixed, default: {} },
  excludedQuestionIds: { type: [String], default: [] },
  selections: { type: mongoose.Schema.Types.Mixed, default: {} },
  topperOverrides: { type: mongoose.Schema.Types.Mixed, default: {} },
}, { timestamps: true });

BookLayoutSchema.index({ subject: 1, paper: 1 }, { unique: true });

export const BookLayout = mongoose.model('BookLayout', BookLayoutSchema);
