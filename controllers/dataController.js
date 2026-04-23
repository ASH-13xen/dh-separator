import { UPSCQA } from '../models/UPSCQA.js';
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

export const getAllQuestions = async (req, res) => {
  try {
    const questions = await UPSCQA.find({}).sort({ createdAt: -1 });
    res.status(200).json(questions);
  } catch (error) {
    console.error("[DataController] Error fetching questions:", error);
    res.status(500).json({ error: 'Failed to retrieve questions from the database.' });
  }
};

export const updateQuestion = async (req, res) => {
  try {
    const { id } = req.params;
    const { tags, file_urls } = req.body;

    const updatedQuestion = await UPSCQA.findByIdAndUpdate(
      id,
      { tags, ...(file_urls && { file_urls }) },
      { new: true, runValidators: true }
    );

    if (!updatedQuestion) {
      return res.status(404).json({ error: 'Question not found' });
    }

    res.status(200).json(updatedQuestion);
  } catch (error) {
    console.error("[DataController] Error updating question:", error);
    res.status(500).json({ error: 'Failed to update question in the database.' });
  }
};

export const getValidTags = async (req, res) => {
  try {
    const constantsDir = path.join(__dirname, '../constants');
    const files = fs.readdirSync(constantsDir).filter(f => f.endsWith('.js'));
    
    const validTags = new Set();
    
    for (const file of files) {
      if (file.startsWith('GS-')) {
         validTags.add(file.replace('.js', ''));
      }
      
      const filePath = path.join(constantsDir, file);
      const modulePath = 'file:///' + filePath.replace(/\\/g, '/');
      const module = await import(modulePath);
      
      const exportKeys = Object.keys(module);
      for (const key of exportKeys) {
        const data = module[key];
        if (Array.isArray(data)) {
           if (file.startsWith('OptionalSubject')) {
              validTags.add(file.replace('.js', ''));
           }
           
           data.forEach(sectionItem => {
             if (sectionItem.section) validTags.add(sectionItem.section);
             if (sectionItem.topics && Array.isArray(sectionItem.topics)) {
               sectionItem.topics.forEach(topicItem => {
                 if (topicItem.title) validTags.add(topicItem.title);
               });
             }
           });
        }
      }
    }
    
    res.status(200).json(Array.from(validTags).sort());
  } catch (error) {
    console.error("[DataController] Error fetching valid tags:", error);
    res.status(500).json({ error: 'Failed to retrieve tags from the server.' });
  }
};

export const getHierarchy = async (req, res) => {
  try {
    const constantsDir = path.join(__dirname, '../constants');
    const files = fs.readdirSync(constantsDir).filter(f => f.endsWith('.js'));
    
    const hierarchyData = {
      gsModules: {},
      optionalSubjects: []
    };
    
    for (const file of files) {
      const filePath = path.join(constantsDir, file);
      const modulePath = 'file:///' + filePath.replace(/\\/g, '/');
      const module = await import(modulePath);
      
      let structure = [];
      const exportKeys = Object.keys(module);
      for (const key of exportKeys) {
        const data = module[key];
        if (Array.isArray(data)) {
           structure = data;
           break;
        }
      }
      
      if (file.startsWith('GS-')) {
         const moduleName = file.replace('.js', '');
         hierarchyData.gsModules[moduleName] = structure;
      } else if (file.startsWith('OptionalSubject')) {
         hierarchyData.optionalSubjects.push(file.replace('.js', ''));
      }
    }
    
    hierarchyData.optionalSubjects.sort();
    
    res.status(200).json(hierarchyData);
  } catch (error) {
    console.error("[DataController] Error fetching hierarchy:", error);
    res.status(500).json({ error: 'Failed to retrieve hierarchy.' });
  }
};
