import mongoose from 'mongoose';

const psirBookSchema = new mongoose.Schema({
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
  pdfFileId: {
    type: String
  },
  pdfUrl: {
    type: String
  },
  pdfData: {
    type: Buffer
  },
  error: { 
    type: String 
  }
}, { 
  timestamps: true 
});

export const PsirBook = mongoose.model('PsirBook', psirBookSchema);
