/**
 * @license
 * SPDX-License-Identifier: Apache-2.0
 */

export interface QCCriterion {
 id: string;
 category: string;
 text: string;
}

/**
 * Tự động phân tích và gán phân loại module dựa vào mã moduleCode hoặc classification có sẵn
 */
export const getEntryType = (entry: any): 'Thùng' | 'Cánh' | 'Đợt' | 'Đợt di động' | 'Mặt HK' | 'CTHT' | 'Gia công ngoài' => {
 if (entry?.classification === 'Phụ kiện' || entry?.moduleCode?.startsWith('PK-')) {
 return 'Gia công ngoài';
 }
 if (entry?.classification) {
 if (entry.classification === 'Tấm hoàn thiện' || entry.classification === 'CTHT') {
 return 'CTHT';
 }
 if (entry.classification === 'Gia Công Ngoài' || entry.classification === 'Gia công ngoài') {
 return 'Gia công ngoài';
 }
 return entry.classification;
 }
 const code = entry?.moduleCode || '';
 const codeLower = code.toLowerCase();

 // 1. Gia công ngoài
 if (
 codeLower.includes('-gcn') || 
 codeLower.includes('gcn') || 
 codeLower.includes('gia cong ngoai') || 
 codeLower.includes('giacongngoai') ||
 codeLower.includes('outsource')
 ) {
 return 'Gia công ngoài';
 }

 // 2. Nhóm Đợt
 if (
 codeLower.includes('đợt') || 
 codeLower.includes('dot') || 
 codeLower.includes('-d') || 
 codeLower.endsWith('d')
 ) {
 return 'Đợt';
 }

 // 3. Nhóm Mặt hộc kéo
 if (
 codeLower.includes('mặt hộc kéo') || 
 codeLower.includes('mat hoc keo') || 
 codeLower.includes('mặt hk') || 
 codeLower.includes('-mhk') || 
 codeLower.includes('-m')
 ) {
 return 'Mặt HK';
 }

 // 4. Nhóm Cánh
 if (
 codeLower.includes('cánh') || 
 codeLower.includes('canh') || 
 codeLower.includes('cửa') || 
 codeLower.includes('cua') || 
 codeLower.includes('-canh') ||
 codeLower.includes('-c')
 ) {
 return 'Cánh';
 }

 // 5. Nhóm CTHT (Cấu kiện hoàn thiện / Tấm hoàn thiện)
 if (
 codeLower.includes('tấm hoàn thiện') || 
 codeLower.includes('tam hoan thien') || 
 codeLower.includes('hoàn thiện') || 
 codeLower.includes('hoan thien') || 
 codeLower.includes('ctht') ||
 code.split('_').length >= 3
 ) {
 return 'CTHT';
 }

 // 6. Mặc định là Thùng
 return 'Thùng';
};

// Định nghĩa các danh sách tiêu chuẩn kiểm QC chuẩn hóa
const whiteCriteriaShared = [
 { id: 'w-1', category: 'Kích thước', text: 'Kích thước.' },
 { id: 'w-2', category: 'Ngoại quan', text: 'Vân gỗ' },
 { id: 'w-3', category: 'Ngoại quan', text: 'Trầy xước' },
 { id: 'w-4', category: 'Ngoại quan', text: 'Nứt tét' },
 { id: 'w-5', category: 'Gia công', text: 'vết keo' },
 { id: 'w-6', category: 'Gia công', text: 'U vít' },
 { id: 'w-7', category: 'Gia công', text: 'Cạnh chỉ' },
 { id: 'w-8', category: 'Bề mặt', text: 'Nguội hàng trắng' },
 { id: 'w-9', category: 'Kết cấu', text: 'SP phải ráp không rung lắc, không biến dạng.' }
];

const paintCriteriaPaint = [
 { id: 'p-1', category: 'Sơn phủ', text: 'Cần đúng màu với mẫu yêu cầu' },
 { id: 'p-2', category: 'Sơn phủ', text: 'Độ bóng phải đúng' },
 { id: 'p-3', category: 'Sơn phủ', text: 'không bong tróc, trầy xước, bụi bẩn' },
 { id: 'p-4', category: 'Sơn phủ', text: 'không chảy sơn, da cam, vết chà nhám' },
 { id: 'p-5', category: 'Sơn phủ', text: 'Các khuyết tật khác sửa không đạt' },
 { id: 'p-6', category: 'Sơn phủ', text: 'Màu phải được phủ ngay cả mặt phía trong và dưới thấy được' }
];

const paintCriteriaOutsource = [
 { id: 'g-p-1', category: 'Sơn phủ', text: 'Cần đúng màu với mẫu yêu cầu' },
 { id: 'g-p-2', category: 'Sơn phủ', text: 'Độ bóng phải đúng' },
 { id: 'g-p-3', category: 'Sơn phủ', text: 'không bong tróc, trầy xước, bụi bẩn' },
 { id: 'g-p-4', category: 'Sơn phủ', text: 'không chảy sơn, vết chà nhám' },
 { id: 'g-p-5', category: 'Sơn phủ', text: 'Màu phải được phủ ngay cả mặt phía trong và dưới thấy được' }
];

const finishCriteriaShared = [
 { id: 'f-1', category: 'Lắp ráp', text: 'Đúng và đủ linh kiện' },
 { id: 'f-2', category: 'Lắp ráp', text: 'Độ hở chi tiết' },
 { id: 'f-3', category: 'Lắp ráp', text: 'Cửa, hộc kéo phải trơn tru' }
];

const packCriteriaShared = [
 { id: 'k-1', category: 'Đóng gói', text: 'Kiểm tra đúng với BOM' },
 { id: 'k-2', category: 'Đóng gói', text: 'khi bao gói sp phải sạch sẻ' },
 { id: 'k-3', category: 'Đóng gói', text: 'Bao gói linh kiện đúng và đủ' },
 { id: 'k-4', category: 'Đóng gói', text: 'tem nhãn dán bên ngoài thùng đúng yêu cầu' }
];

/**
 * Trả về danh sách tiêu chí QC tinh gọn dựa trên phân loại module trực tiếp và giai đoạn kiểm
 */
export const getQCCriteria = (classification: string, stageId: 'white' | 'paint' | 'finish' | 'pack'): QCCriterion[] => {
 const type = classification || 'Thùng';

 const criteriaData: Record<string, Record<'white' | 'paint' | 'finish' | 'pack', QCCriterion[]>> = {
 'Thùng': {
 white: whiteCriteriaShared,
 paint: [], // Thùng không sơn hoặc tự động pass
 finish: finishCriteriaShared,
 pack: packCriteriaShared
 },
 'Cánh': {
 white: whiteCriteriaShared,
 paint: paintCriteriaPaint,
 finish: finishCriteriaShared,
 pack: packCriteriaShared
 },
 'CTHT': {
 white: whiteCriteriaShared,
 paint: paintCriteriaPaint,
 finish: finishCriteriaShared,
 pack: packCriteriaShared
 },
 'Gia công ngoài': {
 white: whiteCriteriaShared,
 paint: paintCriteriaOutsource,
 finish: [],
 pack: []
 },
 'Đợt': {
 white: whiteCriteriaShared,
 paint: [],
 finish: finishCriteriaShared,
 pack: packCriteriaShared
 },
 'Mặt HK': {
 white: whiteCriteriaShared,
 paint: paintCriteriaPaint,
 finish: finishCriteriaShared,
 pack: packCriteriaShared
 }
 };

 const getCollection = () => {
 const defaultData = criteriaData['Thùng'];
 const currentTypeData = criteriaData[type] || defaultData;
 const res = currentTypeData[stageId] || defaultData[stageId] || [];
 if (res.length === 0) {
 const stageNameMap: Record<string, string> = {
 white: 'Hàng Trắng',
 paint: 'Hàng Sơn',
 finish: 'Hoàn Thiện',
 pack: 'Đóng Gói'
 };
 return [{
 id: `gen-${type.replace(/\s+/g, '-')}-${stageId}`,
 category: 'Ngoại quan',
 text: `Kiểm tra chất lượng ngoại quan & kỹ thuật ${stageNameMap[stageId] || ''} chung`
 }];
 }
 return res;
 };

 return getCollection();
};
