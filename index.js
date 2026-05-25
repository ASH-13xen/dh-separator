import express from 'express';
import cors from 'cors';
import dotenv from 'dotenv';
import mongoose from 'mongoose';
import cron from 'node-cron';
import fs from 'fs';
import path from 'path';
import uploadRoutes from './routes/uploadRoutes.js';
import dataRoutes from './routes/dataRoutes.js';
import collectiveRoutes from './routes/collectiveRoutes.js';
import quesPdfRoutes from './routes/quesPdfRoutes.js';

dotenv.config();

const app = express();
const PORT = process.env.PORT || 5000;
const MONGO_URI = process.env.MONGO_URI || 'mongodb://127.0.0.1:27017/upsc_db';

// Middleware
app.use(cors({ origin: '*' }))
app.use(express.json());
app.use('/public', express.static(path.join(process.cwd(), 'public')));

// Daily clean-up cron job for local extracted PDFs
cron.schedule('0 0 * * *', () => {
    const pdfDir = path.join(process.cwd(), 'public', 'extracted_pdfs');
    if (fs.existsSync(pdfDir)) {
        fs.readdir(pdfDir, (err, files) => {
            if (err) return console.error('[Cron] Error reading PDF directory:', err);
            let count = 0;
            files.forEach(file => {
                if (file.endsWith('.pdf')) {
                    fs.unlink(path.join(pdfDir, file), err => {
                        if (err) console.error('[Cron] Error deleting file:', file, err);
                    });
                    count++;
                }
            });
            console.log(`[Cron] Daily Cleanup: Removed ${count} local PDFs`);
        });
    }
});

// Routes
app.use('/api', uploadRoutes);
app.use('/api/data', dataRoutes);
app.use('/api/collective', collectiveRoutes);
app.use('/api/quespdf', quesPdfRoutes);

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
