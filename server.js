import express from 'express';

const app = express();
const port = process.env.PORT || 3000;

const frames = [
`     \    /\
       )  ( ')
      (  /  )
       \(__)|`,

`          \    /\
            )  ( ')
           (  /  )
            \(__)|      o`,

`              \    /\
                )  ( ')
               (  /  )
                \(__)|   o`,

`                  \   /\
                   )  ( ')
                  (  /  )  o
                   \\(__)|
`
];

app.get('/', (req, res) => {
  const frame = frames[Math.floor(Math.random() * frames.length)];

  const svgLines = frame.split('\n').map((line, index) =>
    `<tspan x="10" dy="${index === 0 ? 0 : 16}">${line}</tspan>`
  ).join('');
  const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="350" height="150">
    <rect width="100%" height="100%" fill="black"/>
    <text x="10" y="20" font-family="monospace" font-size="14" fill="white">
      ${svgLines}
    </text>
  </svg>`;
  
  res.setHeader('Content-Type', 'image/svg+xml');
  res.send(svg);
});

app.listen(port, () => {
  console.log(`🐾 Cat server running on http://localhost:${port}`);
});
