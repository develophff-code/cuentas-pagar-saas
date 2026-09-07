import fs from 'fs';
import { invoiceExtractorService } from '../src/modules/extractor/invoice-extractor.service.js';

async function test() {
  const filePath = 'C:/Users/Horacio/.gemini/antigravity/brain/bf7024c7-854c-46dd-a352-efb9b5c9171d/.user_uploaded/media_1788817952243.jpg';
  const buffer = fs.readFileSync(filePath);

  console.log('Testing extraction on user ticket...');
  const result = await invoiceExtractorService.extractFromBuffer(buffer, 'image/jpeg');
  console.log('Extraction success:');
  console.log(JSON.stringify(result, null, 2));
}

test().catch(console.error);
