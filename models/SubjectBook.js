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

export const SubjectBook = mongoose.model('SubjectBook', subjectBookSchema);
