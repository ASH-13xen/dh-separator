import mongoose from 'mongoose';

const subjectBookSchema = new mongoose.Schema({
  subject: {
    type: String,
    required: true
  },
  paper: {
    type: String,
    required: true
  },
  status: {
    type: String,
    enum: ['pending', 'processing', 'completed', 'failed'],
    default: 'pending'
  },
  selections: {
    type: mongoose.Schema.Types.Mixed,
    default: {}
  },
  includedQuestionIds: {
    type: [String],
    default: []
  },
  topicRenames: {
    type: mongoose.Schema.Types.Mixed,
    default: {}
  },
  // { [topicKey]: [questionId, ...] } from the saved BookLayout at generate time — lets the
  // compile runner group each question under the topic the user actually placed it in, instead
  // of falling back to that question's original CSV classification (which is all it would
  // otherwise have, for a question dragged into a different topic than where it was classified).
  questionOrder: {
    type: mongoose.Schema.Types.Mixed,
    default: {}
  },
  topperOverrides: {
    type: mongoose.Schema.Types.Mixed,
    default: {}
  },
  questionTextOverrides: {
    type: mongoose.Schema.Types.Mixed,
    default: {}
  },
  titlePages: {
    type: mongoose.Schema.Types.Mixed,
    default: {}
  },
  // Combined-book ("Generate All Books") jobs only — built by generateCollectiveSubjectBookPdf
  // and consumed by scripts/generateCollectiveSubjectBookPdf.js. Left undefined for a normal
  // single-paper job so that flow is untouched.
  isCollective: {
    type: Boolean,
    default: false
  },
  // Real paper names actually included (in the order they appear in the combined book).
  papers: {
    type: [String],
    default: undefined
  },
  // Sequential display labels (e.g. "Unit 1", "Unit 2") parallel to `papers` — cosmetic-only,
  // computed fresh at generate time, never written back into any BookLayout.
  paperLabels: {
    type: [String],
    default: undefined
  },
  // One entry per included paper: { paper, label, selections, includedQuestionIds,
  // topicRenames, questionOrder, topperOverrides, questionTextOverrides, titlePages } — the
  // same per-paper fields a single-paper job carries, snapshotted for every selected unit.
  paperJobs: {
    type: [mongoose.Schema.Types.Mixed],
    default: undefined
  },
  pdfFileId: {
    type: String
  },
  pdfUrl: {
    type: String
  },
  pdfPublicId: {
    type: String
  },
  pdfData: {
    type: Buffer
  },
  // Set instead of pdfUrl/pdfPublicId when the compiled book was stored as an asset on a
  // draft GitHub release (used for combined books too large for Cloudinary's free-tier raw
  // upload cap). A draft release's assets aren't publicly listed/downloadable, so
  // downloadSubjectBook proxies them through the same GitHub PAT used to dispatch workflows.
  pdfGithubAssetId: {
    type: Number
  },
  error: {
    type: String
  }
}, {
  timestamps: true
});

export const SubjectBook = mongoose.model('SubjectBook', subjectBookSchema);
