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
      topper_marks: String
    }], 
    default: [] 
  },
  createdAt: { type: Date, default: Date.now }
});

export const UPSCQA = mongoose.model('UPSCQA', upscQaSchema);