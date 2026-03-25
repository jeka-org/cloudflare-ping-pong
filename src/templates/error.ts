export function ERROR_HTML(message: string): string {
  return `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8">
  <link rel="icon" type="image/png" href="data:image/png;base64,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">
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
