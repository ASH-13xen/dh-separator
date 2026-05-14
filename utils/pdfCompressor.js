import { exec } from 'child_process';
import os from 'os';
import path from 'path';
import fs from 'fs';

/**
 * Compresses a PDF file using Ghostscript.
 * Resolves with the path to the compressed file.
 * 
 * Requires 'gs' (Ghostscript) to be installed on the system.
 */
export const compressPdf = (inputFilePath) => {
  return new Promise((resolve, reject) => {
    const outputFilePath = path.join(os.tmpdir(), `compressed-${Date.now()}-${Math.round(Math.random() * 1E9)}.pdf`);
    
    // Ghostscript command
    // -sDEVICE=pdfwrite : Use PDF output
    // -dCompatibilityLevel=1.4 : Broad compatibility
    // -dPDFSETTINGS=/printer : High quality (300dpi) suitable for printing and clear OCR
    // -dNOPAUSE -dQUIET -dBATCH : Run without user interaction
    const command = `gs -sDEVICE=pdfwrite -dCompatibilityLevel=1.4 -dPDFSETTINGS=/printer -dNOPAUSE -dQUIET -dBATCH -sOutputFile="${outputFilePath}" "${inputFilePath}"`;

    exec(command, (error, stdout, stderr) => {
      if (error) {
        console.error('[pdfCompressor] Ghostscript compression failed:', error.message);
        // If GS fails (e.g. not installed), we will gracefully return the original uncompressed file
        if (fs.existsSync(outputFilePath)) fs.unlinkSync(outputFilePath);
        return resolve(inputFilePath);
      }
      
      console.log(`[pdfCompressor] Successfully compressed PDF to ${outputFilePath}`);
      resolve(outputFilePath);
    });
  });
};
