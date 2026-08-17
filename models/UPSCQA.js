import mongoose from 'mongoose';

const upscQaSchema = new mongoose.Schema({
  question_text: { type: String, required: true },
  subject: { type: String, required: true, trim: true },
  tags: { type: [String], default: [] },
  start_page: { type: Number, required: true },
  end_page: { type: Number, required: true },
  file_urls: {
    type: [{
      url: String,
      topper_name: String,
      topper_year: String,
      topper_rank: String,
      topper_marks: String,
      // Identifies which single upload action produced this answer sheet, so the "All
      // Uploads" admin view can group every question from one PDF upload into a single row.
      // Absent on answer sheets uploaded before this field existed — those are treated as
      // their own standalone batch of one (see subjectController.js's batch helpers).
      uploadBatchId: String,
      uploadedAt: Date
    }],
    default: []
  },
  createdAt: { type: Date, default: Date.now }
});

export const UPSCQA = mongoose.model('UPSCQA', upscQaSchema);