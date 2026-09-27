import mongoose from 'mongoose';

const subjectSchema = new mongoose.Schema({
  name: { type: String, required: true, unique: true, trim: true },
  slug: { type: String, required: true, unique: true, trim: true, lowercase: true },
  syllabusText: { type: String, default: '' },
  syllabusJson: { type: mongoose.Schema.Types.Mixed, default: null },
  csvData: { type: String, default: '' },
  status: { type: String, enum: ['draft', 'active'], default: 'draft' },
  questionCount: { type: Number, default: 0 },
  // Set only on a "topper book": a frozen copy of another subject's book restricted to a chosen
  // set of toppers' answers. Its csvData is a one-time filtered snapshot of the parent's, so it
  // must never be re-classified from UPSCQA (its name matches no uploaded subject). parentName
  // is what the compiled PDF's cover prints, so the topper names never appear on the cover.
  parentSlug: { type: String, default: null },
  parentName: { type: String, default: null },
  // Topper display names in the order the user picked them — that order decides which answers
  // were auto-ticked first (max 3 per question) when the book was created.
  topperFilter: { type: [String], default: undefined }
}, {
  timestamps: true
});

export const Subject = mongoose.model('Subject', subjectSchema);
