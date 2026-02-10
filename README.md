# Messenger (Telegram-like)

Мессенджер в стиле Telegram с реальным временем доставки сообщений.

## Возможности

- Регистрация и вход
- Поиск пользователей
- Приватные чаты (1 на 1)
- Мгновенная доставка сообщений (WebSocket)
- Индикатор "печатает..."
- Онлайн/оффлайн статус
- Отметки о прочтении
- Счётчик непрочитанных
- Адаптивный дизайн (мобильный + десктоп)
- Тёмная тема в стиле Telegram

## Быстрый старт (локально)

```bash
npm install
npm start
```

Откройте http://localhost:3000

## Как пригласить друга (локальная сеть)

1. Узнайте свой IP: `ipconfig` (Windows) или `ifconfig` (Mac/Linux)
2. Скиньте другу ссылку: `http://ВАШ_IP:3000`
3. Оба зарегистрируйтесь и начните чатиться!

## Быстрый деплой в интернет

### Вариант 1: ngrok (самый быстрый, 5 секунд)

```bash
# Установите ngrok: https://ngrok.com/download
ngrok http 3000
```

Скопируйте https-ссылку и отправьте другу.

### Вариант 2: Railway (бесплатный хостинг)

1. Зайдите на https://railway.app
2. New Project → Deploy from GitHub (или залейте код)
3. Получите публичную ссылку

### Вариант 3: Render

1. Зайдите на https://render.com
2. New → Web Service
3. Подключите репозиторий
4. Build: `npm install`, Start: `npm start`

## Стек

- **Backend**: Node.js, Express, Socket.IO
- **Database**: SQLite (better-sqlite3)
- **Auth**: JWT + bcrypt
- **Frontend**: Vanilla HTML/CSS/JS
