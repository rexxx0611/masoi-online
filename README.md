# 🐺 Ma Sói Online

Game Ma Sói multiplayer chạy online qua trình duyệt — không cần cài app.

## Cấu trúc file

```
masoi-online/
├── server.js          ← Node.js server + Socket.io (toàn bộ logic game)
├── package.json       ← Dependencies
├── public/
│   └── index.html    ← Client (HTML + CSS + JS, single file)
└── README.md
```

## Chạy trên máy tính cá nhân

```bash
# 1. Cài Node.js từ https://nodejs.org (v18+)

# 2. Vào thư mục game
cd masoi-online

# 3. Cài dependencies
npm install

# 4. Chạy server
npm start

# 5. Mở trình duyệt → http://localhost:3000
```

---

## Deploy lên máy chủ (miễn phí)

### Option 1 — Railway (khuyến nghị, miễn phí)

1. Tạo tài khoản tại https://railway.app
2. New Project → Deploy from GitHub repo
3. Upload code lên GitHub repo bất kỳ
4. Railway tự phát hiện Node.js và deploy
5. Lấy URL dạng `xxx.railway.app` → chia sẻ cho bạn bè

### Option 2 — Render (miễn phí, ngủ sau 15 phút không dùng)

1. Tạo tài khoản tại https://render.com
2. New → Web Service → Connect GitHub repo
3. Build Command: `npm install`
4. Start Command: `npm start`
5. Deploy → lấy URL `xxx.onrender.com`

### Option 3 — Fly.io

```bash
# Cài flyctl
curl -L https://fly.io/install.sh | sh

# Login và deploy
fly auth login
fly launch      # chọn region gần Việt Nam: sin (Singapore)
fly deploy
```

### Option 4 — VPS (DigitalOcean, Vultr, Linode ~$6/tháng)

```bash
# Trên VPS Ubuntu
sudo apt update && sudo apt install nodejs npm nginx -y
npm install -g pm2

# Upload code lên VPS, vào thư mục
cd masoi-online
npm install
pm2 start server.js --name masoi
pm2 save && pm2 startup

# Nginx reverse proxy (tuỳ chọn, để dùng port 80)
# /etc/nginx/sites-available/masoi:
# server {
#   listen 80;
#   server_name yourdomain.com;
#   location / { proxy_pass http://localhost:3000; proxy_http_version 1.1;
#     proxy_set_header Upgrade $http_upgrade;
#     proxy_set_header Connection 'upgrade'; }
# }
```

---

## Cách chơi

1. **Người host**: nhập tên → Tạo Phòng Mới → cài đặt vai trò → chia sẻ mã 6 ký tự
2. **Người chơi**: nhập tên + mã phòng → Tham Gia Phòng
3. Host bắt đầu game khi đủ người
4. Mỗi người nhận vai bí mật → đêm/ngày xen kẽ cho đến khi có phe thắng

## Roles

| Vai | Phe | Chức năng |
|-----|-----|-----------|
| 👨‍🌾 Dân Làng | Dân | Bỏ phiếu ban ngày |
| 🐺 Ma Sói | Sói | Đêm vote giết 1 người |
| 🔮 Tiên Tri | Dân | Đêm xem 1 người có phải sói |
| 🧙‍♀️ Phù Thủy | Dân | 1 lần: cứu hoặc giết |
| 🏹 Thợ Săn | Dân | Khi chết: bắn 1 người (10 giây) |
| 🛡️ Bảo Vệ | Dân | Đêm bảo vệ 1 người khỏi sói |
| 😈 Kẻ Bị Nguyền | Dân→Sói | Bị cắn → biến thành sói |
| 😑 Kẻ Chán Đời | Trung lập | Thắng khi bị làng treo cổ |
| 🧛 Ma Cà Rồng | Trung lập | Đêm hút máu — nạn nhân chết hôm sau |

## Luật thắng

- **Dân Làng**: loại hết Sói và Ma Cà Rồng
- **Ma Sói**: số sói ≥ số người còn lại
- **Ma Cà Rồng**: chỉ còn vampire và ≤1 người khác
- **Kẻ Chán Đời**: bị làng treo cổ

## Biến môi trường

```bash
PORT=3000   # cổng server (Railway/Render tự set)
```
