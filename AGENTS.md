# Custom Instructions

- Luôn giao tiếp với người dùng bằng tiếng Việt.
- Ưu tiên sự ngắn gọn, tập trung vào kết quả công việc.

## Design Guidelines (Flat Dashboard Style)
- **Color Palette**: Use a clean, professional palette (e.g., Indigo/Slate for primary, Emerald for success). Tuyệt đối không dùng mã màu lẻ kết thúc bằng 50 mang tính chất lai như `slate-150`, `slate-250`, `slate-450`... Phải sử dụng phân cấp chuẩn của Tailwind CSS (ví dụ `slate-100`, `slate-200`, `slate-300`, ...).
- **Color Shades**: Tuyệt đối KHÔNG dùng shade `-50` (ví dụ `bg-slate-50`, `text-emerald-50`). Luôn dùng từ `-100` trở lên. Ví dụ: `bg-slate-50` → `bg-slate-100`, `bg-emerald-50` → `bg-emerald-100`. Không dùng shade lẻ `-150`, `-250`, `-350`, `-450`... chỉ dùng số chẵn: 100, 200, 300, 400, 500, 600, 700, 800, 900.
- **No Dark Mode**: Tuyệt đối KHÔNG dùng `dark:` prefix. Toàn bộ app chỉ có giao diện sáng (light mode). Bỏ mọi class `dark:bg-*`, `dark:text-*`, `dark:border-*`, `dark:hover:*`, `dark:shadow-*`...
- **Typography**: Use standard web fonts (Inter for body, Outfit/Space Grotesk for headings).
- **Layout**: Flat cards with subtle borders (`border-gray-100`), no heavy shadows, consistent padding (standard `p-4` or `p-6`).
- **Icons**: Lucide-React consistently.
- **Controls**: Tất cả các khung, nút, nhãn (label) và phần tử giao diện đều dùng bo góc tối thiểu là `rounded-lg` (rounded border nhỏ nhất là `lg`, tuyệt đối không dùng `rounded-sm` hay `rounded-md`).
- **PC optimization**: Ensure readable font sizes (14px-16px for body) and clean spacing on wider screens.

## QC Inspection & Storage Rules
- **Lưu trữ dữ liệu QC**: Tất cả các thông tin kiểm định QC (như trạng thái kiểm định, ghi chú, ảnh chụp, người kiểm, ngày kiểm, tiêu chí đạt/lỗi) phải được lưu trực tiếp vào từng instance cụ thể thuộc mảng `instances` của module, tuyệt đối không lưu hoặc ghi đè trực tiếp lên các trường thuộc tính QC ở cấp độ module (root module level) khi module có instances.
- **Không dùng tương thích ngược**: Tuyệt đối không sử dụng cơ chế fallback (tương thích ngược) về cấp độ module khi hiển thị thông tin QC ở trang chi tiết. Toàn bộ thông tin QC phải được truy xuất trực tiếp và hiển thị theo từng instance cụ thể.

## Item Classification Rules (Packing & Loading)
- **Phân loại kiện CHỈ dùng subType**: Kiện Module = `kienModule`, Kiện CTHT = `kienCTHT`, Kiện Phụ kiện = `kienPhuKien`.
- **Tuyệt đối KHÔNG** dùng tên kiện (name pattern như `'Kiện CTHT'`, `'FINISHED PANEL'`), cluster (`'Chi tiết hỗ trợ'`), hay bất kỳ tiêu chí nào khác khi lọc, lưu, hoặc đếm kiện theo loại.
- Helper functions (`isCthtItem`, `isPhuKienItem`, `isCthtKien`) **PHẢI** check `subType` field, không được check name hay cluster.
- **Applies to**: PackingScreen, LoadingExcelEditorModal, LoadingScreen, PKLDetailScreen, PackingExcelEditorModal — mọi nơi phân loại kiện theo loại.

## Security Rules
- **Không được update rules firestore**: Tuyệt đối không sửa đổi file `firestore.rules`. Mọi thay đổi quyền truy cập Firestore phải được thực hiện thủ công bởi admin.
