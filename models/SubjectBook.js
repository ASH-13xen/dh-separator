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
  // { [topicKey]: [questionId, ...] } from the saved BookLayout at generate time — lets the
  // compile runner group each question under the topic the user actually placed it in, instead
  // of falling back to that question's original CSV classification (which is all it would
  // otherwise have, for a question dragged into a different topic than where it was classified).
  questionOrder: {
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
  pdfPublicId: {
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
