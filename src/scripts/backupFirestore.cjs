/* eslint-disable */
const fs = require('fs');
const path = require('path');
const https = require('https');

const config = require('../../firebase-applet-config.json');
const PROJECT_ID = config.projectId;
const API_KEY = config.apiKey;
const DB_ID = config.firestoreDatabaseId || '(default)';

const COLLECTIONS = ['projects', 'packing', 'loading', 'loading_histories', 'activities', 'qc_tickets', 'projectConfigs'];

const backupsDir = path.join(__dirname, '..', 'backups');
if (!fs.existsSync(backupsDir)) fs.mkdirSync(backupsDir, { recursive: true });

function fetchDocuments(collection) {
  return new Promise((resolve, reject) => {
    const url = `https://firestore.googleapis.com/v1/projects/${PROJECT_ID}/databases/${DB_ID}/documents/${collection}?key=${API_KEY}`;
    https.get(url, (res) => {
      let data = '';
      res.on('data', chunk => data += chunk);
      res.on('end', () => {
        try {
          const parsed = JSON.parse(data);
          if (parsed.documents) {
            resolve(parsed.documents.map(doc => ({
              id: doc.name.split('/').pop(),
              ...flattenFirestoreFields(doc.fields || {})
            })));
          } else {
            resolve([]);
          }
        } catch (e) {
          console.error(`Error parsing ${collection}:`, e.message);
          resolve([]);
        }
      });
    }).on('error', (e) => {
      console.error(`Network error for ${collection}:`, e.message);
      resolve([]);
    });
  });
}

function flattenFirestoreFields(fields) {
  const result = {};
  for (const [key, val] of Object.entries(fields)) {
    if (val.stringValue !== undefined) result[key] = val.stringValue;
    else if (val.integerValue !== undefined) result[key] = Number(val.integerValue);
    else if (val.doubleValue !== undefined) result[key] = val.doubleValue;
    else if (val.booleanValue !== undefined) result[key] = val.booleanValue;
    else if (val.timestampValue !== undefined) result[key] = val.timestampValue;
    else if (val.arrayValue) result[key] = (val.arrayValue.values || []).map(v => {
      if (v.stringValue !== undefined) return v.stringValue;
      if (v.integerValue !== undefined) return Number(v.integerValue);
      if (v.doubleValue !== undefined) return v.doubleValue;
      if (v.booleanValue !== undefined) return v.booleanValue;
      if (v.mapValue) return flattenFirestoreFields(v.mapValue.fields || {});
      return v;
    });
    else if (val.mapValue) result[key] = flattenFirestoreFields(val.mapValue.fields || {});
    else if (val.nullValue !== undefined) result[key] = null;
    else if (val.geoPointValue) result[key] = val.geoPointValue;
    else if (val.referenceValue) result[key] = val.referenceValue;
    else result[key] = val;
  }
  return result;
}

async function backup() {
  const backupData = {};
  const dateStr = new Date().toISOString().slice(0, 10);

  console.log(`Backup Firestore: ${PROJECT_ID}`);
  console.log(`Collections: ${COLLECTIONS.join(', ')}`);

  for (const col of COLLECTIONS) {
    const docs = await fetchDocuments(col);
    backupData[col] = docs;
    console.log(`  ${col}: ${docs.length} documents`);
  }

  const filePath = path.join(backupsDir, `backup_${dateStr}.json`);
  fs.writeFileSync(filePath, JSON.stringify(backupData, null, 2), 'utf8');
  console.log(`\nBackup saved: ${filePath}`);
  console.log(`Total documents: ${Object.values(backupData).reduce((sum, docs) => sum + docs.length, 0)}`);
}

backup().catch(console.error);
