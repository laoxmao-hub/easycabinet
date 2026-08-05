/* eslint-disable */
/**
 * Script migrate collection packing_lists → loading
 *
 * Chạy: node src/scripts/migratePackinListsToLoading.cjs
 *
 * Lưu ý:
 * - Cần service account key Firebase (đặt trong src/scripts/serviceAccount.json)
 * - Firestore KHÔNG cho xóa collection gốc → script chỉ copy
 * - Sau khi chạy xong, kiểm tra data trong Firestore Console
 * - Khi chắc chắn đúng, xóa thủ công collection packing_lists trên Firebase Console
 */

const admin = require('firebase-admin');
const path = require('path');

// Load service account
try {
  const serviceAccount = require('./serviceAccount.json');
  admin.initializeApp({
    credential: admin.credential.cert(serviceAccount),
  });
} catch (err) {
  console.error('❌ Không tìm thấy serviceAccount.json trong src/scripts/');
  console.error('   Tải service account key từ Firebase Console → Project Settings → Service Accounts');
  console.error('   Lưu thành: src/scripts/serviceAccount.json');
  process.exit(1);
}

const db = admin.firestore();
const SOURCE = 'packing_lists';
const TARGET = 'loading';

async function migrate() {
  console.log(`\n📦 Bắt đầu migrate: ${SOURCE} → ${TARGET}\n`);

  // 1. Đọc tất cả documents từ source
  const sourceSnap = await db.collection(SOURCE).get();
  if (sourceSnap.empty) {
    console.log(`✅ Collection "${SOURCE}" trống, không cần migrate.`);
    return;
  }

  console.log(`📄 Tìm thấy ${sourceSnap.size} documents trong "${SOURCE}"\n`);

  // 2. Copy từng document sang target
  const batch = db.batch();
  let count = 0;

  for (const doc of sourceSnap.docs) {
    const targetRef = db.collection(TARGET).doc(doc.id);
    batch.set(targetRef, doc.data());
    count++;

    // Firestore batch limit = 500
    if (count % 500 === 0) {
      await batch.commit();
      console.log(`   ✅ Đã copy ${count}/${sourceSnap.size} documents...`);
    }
  }

  // Commit phần còn lại
  if (count % 500 !== 0) {
    await batch.commit();
  }

  console.log(`\n🎉 Hoàn tất! Đã copy ${count} documents từ "${SOURCE}" sang "${TARGET}"`);
  console.log(`\n⚠️  Bước tiếp theo: Xóa collection "${SOURCE}" thủ công trên Firebase Console`);
  console.log(`   → Firestore Console → Data → collection "${SOURCE}" → xóa từng document\n`);
}

migrate()
  .then(() => process.exit(0))
  .catch((err) => {
    console.error('❌ Lỗi migration:', err);
    process.exit(1);
  });
