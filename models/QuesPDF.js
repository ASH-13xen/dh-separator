import mongoose from 'mongoose';

const quesPdfSchema = new mongoose.Schema({
  originalName: { type: String, required: true },
  questions: [{
    page_number: { type: Number, required: true },
    question_text: { type: String, required: true }
  }],
  pdfUrl: { type: String, required: true },
  createdAt: { type: Date, default: Date.now }
});

export const QuesPDF = mongoose.model('QuesPDF', quesPdfSchema);
