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
