# 🎬 M3U8 Proxy

![Node.js](https://img.shields.io/badge/Node.js-18%2B-green)
![Express](https://img.shields.io/badge/Express.js-Backend-black)
![License](https://img.shields.io/badge/License-MIT-blue)
![Status](https://img.shields.io/badge/Status-Active-success)

A lightweight **Node.js + Express** proxy service for handling `.m3u8` streams and their associated resources (segments, encryption keys, subtitles, audio, and images).

Some streaming providers require specific headers (like `Referer`) or special request handling. This proxy simplifies integration with custom players by handling those requirements for you.

---

## 🚀 Features

- 📡 Proxy `.m3u8` manifests with optional **Referer support**
- 🎥 Stream video segments (`.ts`, `.mp4`)
- 🔑 Handle encryption keys
- 📝 Proxy subtitles (`.vtt`, `.srt`)
- 🔊 Support audio streams
- 🖼️ Proxy images & thumbnails
- 🔗 Generic raw proxy endpoint
- 🧪 Built-in test player (`/test`)
- 🧾 Clean and readable logs

---

## 📸 Preview

> Open in browser after starting the server:

```
http://localhost:3000/test
```

*(Add a GIF or screenshot here for better presentation)*

---

## 📦 Installation

```bash
git clone https://github.com/developerTested/m3u8-proxy.git
cd m3u8-proxy
npm install
```

---

## ▶️ Usage

### 🔧 Development Mode

```bash
npm run dev
```

### 🚀 Production Mode

```bash
npm start
```

Server will run on:

```
http://localhost:3000
```

---

## 🔗 API Endpoints

| Endpoint | Description |
|----------|------------|
| `/test` | Test video player |
| `/proxy/m3u8` | Proxy `.m3u8` manifest (supports referer) |
| `/proxy/segment` | Proxy video segments |
| `/proxy/key` | Proxy encryption keys |
| `/proxy/subtitle` | Proxy subtitle files |
| `/proxy/audio` | Proxy audio streams |
| `/proxy/image` | Proxy images/thumbnails |
| `/proxy/raw` | Generic proxy for any resource |

---

## 🧪 Example Usage

### Proxy M3U8 with Referer

```bash
http://localhost:3000/proxy/m3u8?url=<encoded_m3u8_url>&referer=<encoded_referer_url>
```

### Proxy Segment

```bash
http://localhost:3000/proxy/segment?url=<encoded_segment_url>
```

---

## ⚙️ Important Notes

- 🔐 Always **URL-encode** resource URLs
- 🌐 Some streams require a **Referer header**
- 🧪 Intended for **development & testing only**
- ⚠️ Respect streaming service terms and legal policies

---

## 💡 Use Cases

- Custom video players
- HLS stream debugging
- Handling restricted streams
- Testing streaming integrations

---

## 🛠 Tech Stack

- Node.js
- Express.js

---

## 📄 License

This project is licensed under the **MIT License**.

---

## ⭐ Support

If you find this useful:

- ⭐ Star the repo
- 🍴 Fork it
- 🛠 Contribute improvements

---

## 🤝 Contributing

Pull requests are welcome! For major changes, please open an issue first.

---

## 📬 Contact

For questions or suggestions, feel free to open an issue.

---