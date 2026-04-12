import express from 'express';
import cors from 'cors';
import dotenv from 'dotenv';
import mongoose from 'mongoose';
import uploadRoutes from './routes/uploadRoutes.js';
import dataRoutes from './routes/dataRoutes.js';
import collectiveRoutes from './routes/collectiveRoutes.js';

dotenv.config();

const app = express();
const PORT = process.env.PORT || 5000;
const MONGO_URI = process.env.MONGO_URI || 'mongodb://127.0.0.1:27017/upsc_db';

// Middleware
app.use(cors({ origin: '*' }))
app.use(express.json());

// Routes
app.use('/api', uploadRoutes);
app.use('/api/data', dataRoutes);
app.use('/api/collective', collectiveRoutes);
app.use('/extracted_pdfs', express.static('public/extracted_pdfs'));

// Database Connection
mongoose.connect(MONGO_URI)
  .then(() => {
    console.log('Successfully connected to MongoDB.');
    app.listen(PORT, () => {
      console.log(`Server is running on port ${PORT}`);
    });
  })
  .catch((err) => {
    console.error('Failed to connect to MongoDB:', err);
    process.exit(1);
  });
