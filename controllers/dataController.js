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
    const hierarchyPath = path.join(__dirname, '../syllabus_hierarchy.json');
    if (!fs.existsSync(hierarchyPath)) {
      return res.status(200).json([]);
    }
    
    const customData = JSON.parse(fs.readFileSync(hierarchyPath, 'utf8'));
    const validTags = new Set();
    
    if (customData.gsModules) {
      Object.entries(customData.gsModules).forEach(([mod, sections]) => {
        validTags.add(mod);
        if (Array.isArray(sections)) {
          sections.forEach(secItem => {
            if (secItem.section) validTags.add(secItem.section);
            if (secItem.topics && Array.isArray(secItem.topics)) {
              secItem.topics.forEach(topicItem => {
                if (topicItem.title) validTags.add(topicItem.title);
              });
            }
          });
        }
      });
    }
    
    if (customData.optionalSubjects) {
      Object.entries(customData.optionalSubjects).forEach(([sub, sections]) => {
        validTags.add(sub);
        if (Array.isArray(sections)) {
          sections.forEach(secItem => {
            if (secItem.section) validTags.add(secItem.section);
            if (secItem.topics && Array.isArray(secItem.topics)) {
              secItem.topics.forEach(topicItem => {
                if (topicItem.title) validTags.add(topicItem.title);
              });
            }
          });
        }
      });
    }
    
    res.status(200).json(Array.from(validTags).sort());
  } catch (error) {
    console.error("[DataController] Error fetching valid tags:", error);
    res.status(500).json({ error: 'Failed to retrieve tags from the server.' });
  }
};

export const getHierarchy = async (req, res) => {
  try {
    const hierarchyPath = path.join(__dirname, '../syllabus_hierarchy.json');
    if (!fs.existsSync(hierarchyPath)) {
      return res.status(200).json({ gsModules: {}, optionalSubjects: {} });
    }
    const data = JSON.parse(fs.readFileSync(hierarchyPath, 'utf8'));
    res.status(200).json(data);
  } catch (error) {
    console.error("[DataController] Error fetching hierarchy:", error);
    res.status(500).json({ error: 'Failed to retrieve hierarchy.' });
  }
};

export const addCustomTag = async (req, res) => {
  try {
    const { type, name, parentModule, parentSection } = req.body;
    if (!type || !name) {
      return res.status(400).json({ error: "Type and name are required." });
    }
    
    const hierarchyPath = path.join(__dirname, '../syllabus_hierarchy.json');
    
    let customData = {
      gsModules: {},
      optionalSubjects: {}
    };
    
    if (fs.existsSync(hierarchyPath)) {
      try {
        customData = JSON.parse(fs.readFileSync(hierarchyPath, 'utf8'));
      } catch (err) {
        console.error("Error parsing existing syllabus_hierarchy.json:", err);
      }
    }
    
    if (!customData.gsModules) customData.gsModules = {};
    if (!customData.optionalSubjects) customData.optionalSubjects = {};
    
    let moduleName = '';
    let createdTagName = name;
    
    if (type === 'gsModule' || type === 'optionalSubject') {
      moduleName = name;
    } else {
      moduleName = parentModule;
    }
    
    if (!moduleName) {
      return res.status(400).json({ error: "parentModule is required for sections and topics." });
    }
    
    // Normalize optional subject name to start with OptionalSubject
    if (type.startsWith('optional')) {
      if (!moduleName.startsWith('OptionalSubject')) {
        const cleanName = moduleName.replace(/\s+/g, '');
        moduleName = `OptionalSubject${cleanName.charAt(0).toUpperCase()}${cleanName.slice(1)}`;
      }
      if (type === 'optionalSubject') {
        createdTagName = moduleName;
      }
    }
    
    if (type === 'gsModule') {
      if (!customData.gsModules[moduleName]) {
        customData.gsModules[moduleName] = [];
      }
    } else if (type === 'optionalSubject') {
      if (!customData.optionalSubjects[moduleName]) {
        customData.optionalSubjects[moduleName] = [];
      }
    } else if (type === 'gsSection') {
      if (!customData.gsModules[moduleName]) {
        customData.gsModules[moduleName] = [];
      }
      const existingSec = customData.gsModules[moduleName].find(s => s.section === name);
      if (!existingSec) {
        customData.gsModules[moduleName].push({ section: name, topics: [] });
      }
    } else if (type === 'optionalSection') {
      if (!customData.optionalSubjects[moduleName]) {
        customData.optionalSubjects[moduleName] = [];
      }
      const existingSec = customData.optionalSubjects[moduleName].find(s => s.section === name);
      if (!existingSec) {
        customData.optionalSubjects[moduleName].push({ section: name, topics: [] });
      }
    } else if (type === 'gsTopic') {
      if (!parentSection) {
        return res.status(400).json({ error: "parentSection is required for GS topics." });
      }
      if (!customData.gsModules[moduleName]) {
        customData.gsModules[moduleName] = [];
      }
      let existingSec = customData.gsModules[moduleName].find(s => s.section === parentSection);
      if (!existingSec) {
        existingSec = { section: parentSection, topics: [] };
        customData.gsModules[moduleName].push(existingSec);
      }
      if (!existingSec.topics) existingSec.topics = [];
      const existingTop = existingSec.topics.find(t => t.title === name);
      if (!existingTop) {
        existingSec.topics.push({ title: name, subtopics: [] });
      }
    } else if (type === 'optionalTopic') {
      if (!parentSection) {
        return res.status(400).json({ error: "parentSection is required for optional topics." });
      }
      if (!customData.optionalSubjects[moduleName]) {
        customData.optionalSubjects[moduleName] = [];
      }
      let existingSec = customData.optionalSubjects[moduleName].find(s => s.section === parentSection);
      if (!existingSec) {
        existingSec = { section: parentSection, topics: [] };
        customData.optionalSubjects[moduleName].push(existingSec);
      }
      if (!existingSec.topics) existingSec.topics = [];
      const existingTop = existingSec.topics.find(t => t.title === name);
      if (!existingTop) {
        existingSec.topics.push({ title: name, subtopics: [] });
      }
    }
    
    fs.writeFileSync(hierarchyPath, JSON.stringify(customData, null, 2), 'utf8');
    
    res.status(200).json({ success: true, name: createdTagName });
  } catch (error) {
    console.error("[DataController] Error adding custom tag:", error);
    res.status(500).json({ error: 'Failed to add custom tag.' });
  }
};
