import mongoose from 'mongoose';
import dotenv from 'dotenv';
import { UPSCQA } from './models/UPSCQA.js';

dotenv.config();

mongoose.connect(process.env.MONGO_URI || 'mongodb://127.0.0.1:27017/upsc_db')
  .then(async () => {
    console.log('Connected to MongoDB.');
    const qCount = await UPSCQA.countDocuments({});
    console.log('Total questions:', qCount);

    const oneQ = await UPSCQA.findOne({});
    console.log('Sample question document:', JSON.stringify(oneQ, null, 2));

    const uniqueTags = await UPSCQA.distinct('tags');
    console.log('Sample tags present in DB:', uniqueTags.slice(0, 30));

    mongoose.disconnect();
  })
  .catch(err => {
    console.error(err);
  });
