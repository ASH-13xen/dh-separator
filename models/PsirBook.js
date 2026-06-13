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
  pdfUrl: { 
    type: String 
  },
  error: { 
    type: String 
  }
}, { 
  timestamps: true 
});

export const PsirBook = mongoose.model('PsirBook', psirBookSchema);
