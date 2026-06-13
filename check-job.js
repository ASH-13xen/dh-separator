import mongoose from 'mongoose';
import dotenv from 'dotenv';
import { PsirBook } from './models/PsirBook.js';

dotenv.config();

mongoose.connect(process.env.MONGO_URI)
  .then(async () => {
    console.log('Connected to MongoDB.');
    const jobId = '6a2dd35c962a0c4bd7d081f4';
    const job = await PsirBook.findById(jobId).select('-pdfData');
    if (!job) {
      console.log('Job not found!');
    } else {
      console.log('Job found:', {
        id: job._id,
        paper: job.paper,
        status: job.status,
        error: job.error,
        createdAt: job.createdAt,
        updatedAt: job.updatedAt,
        selectionsCount: Object.keys(job.selections || {}).length,
        includedQuestionsCount: (job.includedQuestionIds || []).length,
      });
    }
    mongoose.disconnect();
  })
  .catch(err => {
    console.error(err);
  });
