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
  },
  createdAt: { 
    type: Date, 
    default: Date.now 
  },
  updatedAt: { 
    type: Date, 
    default: Date.now 
  }
});

// Auto-update updatedAt field on save
psirBookSchema.pre('save', function (next) {
  this.updatedAt = Date.now();
  next();
});

export const PsirBook = mongoose.model('PsirBook', psirBookSchema);
