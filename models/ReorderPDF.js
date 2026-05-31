import mongoose from 'mongoose';

const reorderPdfSchema = new mongoose.Schema({
  originalName: { type: String, required: true },
  chunks: [{
    question_text: { type: String, required: true },
    start_page: { type: Number, required: true },
    end_page: { type: Number, required: true },
    file_url: { type: String, required: true }
  }],
  pdfUrl: { type: String }, // compiled/merged PDF url
  createdAt: { type: Date, default: Date.now }
});

export const ReorderPDF = mongoose.model('ReorderPDF', reorderPdfSchema);
