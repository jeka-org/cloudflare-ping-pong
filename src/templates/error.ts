export function ERROR_HTML(message: string): string {
  return `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8">
  <link rel="icon" href="data:image/svg+xml,<svg xmlns=%27http://www.w3.org/2000/svg%27 viewBox=%270 0 100 100%27><text y=%27.9em%27 font-size=%2790%27>🔥</text></svg>">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <title>Global Pong - Room Not Available</title>
  <style>
    * { margin: 0; padding: 0; box-sizing: border-box; }
    body {
      font-family: 'Courier New', monospace;
      background: #0a0a0a;
      color: #f5f5f5;
      display: flex;
      flex-direction: column;
      align-items: center;
      justify-content: center;
      min-height: 100vh;
      padding: 40px 20px;
    }
    h1 { font-size: 2rem; color: #f97316; margin-bottom: 1rem; }
    p { font-size: 1.2rem; opacity: 0.7; margin-bottom: 2rem; text-align: center; }
    a {
      background: linear-gradient(135deg, #f97316, #ea580c);
      color: #000;
      text-decoration: none;
      padding: 1rem 3rem;
      font-size: 1.2rem;
      font-weight: bold;
      font-family: 'Courier New', monospace;
    }
    a:hover { box-shadow: 0 0 30px rgba(249,115,22,0.5); }
  </style>
</head>
<body>
  <h1>🏓 Room Not Available</h1>
  <p>${message}</p>
  <a href="/">Back to Lobby</a>
</body>
</html>`;
}
