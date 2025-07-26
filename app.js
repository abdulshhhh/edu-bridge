require('dotenv').config();
const express = require('express');
const { STSClient, GetCallerIdentityCommand } = require("@aws-sdk/client-sts");
const { TextractClient, AnalyzeDocumentCommand } = require('@aws-sdk/client-textract');
const cors = require('cors');
const multer = require('multer');

const textractClient = new TextractClient({
  region: process.env.AWS_REGION || 'ap-south-1',
});

function parseFormKeyValues(blocks) {
  const blocksMap = new Map(blocks.map(block => [block.Id, block]));
  const keyBlocks = blocks.filter(b => b.BlockType === 'KEY_VALUE_SET' && b.EntityTypes.includes('KEY'));
  const extractedData = {};
  for (const keyBlock of keyBlocks) {
    const keyText = getChildText(keyBlock, blocksMap);
    const valueBlock = findValueBlock(keyBlock, blocksMap);
    const valueText = getChildText(valueBlock, blocksMap);
    const cleanKey = keyText.replace(/:/g, '').trim();
    if (cleanKey) {
        extractedData[cleanKey] = valueText;
    }
  }
  return extractedData;
}

function findValueBlock(keyBlock, blocksMap) {
  let valueBlock = null;
  if (keyBlock.Relationships) {
    const valueRelationship = keyBlock.Relationships.find(r => r.Type === 'VALUE');
    if (valueRelationship) {
      const valueId = valueRelationship.Ids[0];
      valueBlock = blocksMap.get(valueId);
    }
  }
  return valueBlock;
}

function getChildText(block, blocksMap) {
  if (!block || !block.Relationships) return '';
  let text = '';
  const childRelationship = block.Relationships.find(r => r.Type === 'CHILD');
  if (childRelationship) {
    text = childRelationship.Ids
      .map(id => blocksMap.get(id)?.Text || (blocksMap.get(id)?.SelectionStatus ? `[${blocksMap.get(id).SelectionStatus}]` : ''))
      .join(' ');
  }
  return text.trim();
}

function parseRawText(blocks) {
  const lineBlocks = blocks.filter(block => block.BlockType === 'LINE');
  const text = lineBlocks.map(block => block.Text).join('\n');
  return text;
}

function determineDisabilityType(text) {
  const lowerText = text.toLowerCase();
  if (/\b(blind|blindness)\b/.test(lowerText)) return 'blind';
  if (/\b(deaf|hearing impaired)\b/.test(lowerText)) return 'deaf';
  return 'normal';
}

async function verifyAwsCredentials() {
  console.log("Verifying AWS credentials...");
  try {
    const stsClient = new STSClient({ region: process.env.AWS_REGION || 'ap-south-1' });
    const command = new GetCallerIdentityCommand({});
    const response = await stsClient.send(command);
    console.log("✅ AWS Credentials are valid.");
  } catch (error) {
    console.error("❌ AWS Credential verification failed.");
    process.exit(1);
  }
}

function awsErrorHandler(err, req, res, next) {
  if (err && err.$metadata && err.$metadata.httpStatusCode) {
    const clientMessage = `An error occurred while processing your request. Please try again later. (Error: ${err.name})`;
    return res.status(err.$metadata?.httpStatusCode || 500).json({ success: false, error: clientMessage });
  }
  next(err);
}

function genericErrorHandler(err, req, res, next) {
  res.status(500).json({ success: false, error: "An internal server error occurred. Please try again later." });
}

const app = express();
const upload = multer({ storage: multer.memoryStorage() });

app.use(cors());
app.use(express.json());
app.use(express.static('public'));

app.post('/analyze', upload.single('document'), async (req, res, next) => {
  try {
    if (!req.file || !req.file.buffer || req.file.buffer.length === 0) {
      return res.status(400).json({ success: false, error: 'No document uploaded or the file is empty.' });
    }

    const params = {
      Document: {
        Bytes: req.file.buffer
      },
      FeatureTypes: ['FORMS', 'TABLES']
    };

    const command = new AnalyzeDocumentCommand(params);
    const response = await textractClient.send(command);
    const blocks = response.Blocks || [];
    const keyValuePairs = parseFormKeyValues(blocks);
    const rawText = parseRawText(blocks);
    const disabilityType = determineDisabilityType(rawText);

    res.json({ 
      success: true, 
      keyValuePairs,
      rawText,
      disabilityType,
      documentMetadata: response.DocumentMetadata,
      blockCount: blocks.length
    });
  } catch (error) {
    next(error);
  }
});

app.use(awsErrorHandler);
app.use(genericErrorHandler);

const PORT = process.env.PORT || 5000;

const startServer = async () => {
  await verifyAwsCredentials();
  app.listen(PORT, () => {
    console.log(`🚀 Server running on port ${PORT}`);
  });
};

startServer();