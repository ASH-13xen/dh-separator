import mongoose from 'mongoose';

const subjectSchema = new mongoose.Schema({
  name: { type: String, required: true, unique: true, trim: true },
  slug: { type: String, required: true, unique: true, trim: true, lowercase: true },
  syllabusText: { type: String, required: true },
  csvData: { type: String, default: '' },
  status: { type: String, enum: ['draft', 'active'], default: 'draft' },
  questionCount: { type: Number, default: 0 }
}, {
  timestamps: true
});

export const Subject = mongoose.model('Subject', subjectSchema);
