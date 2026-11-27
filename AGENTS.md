# Deploy Hyper Bot

For Windows or macOS deployment, follow [the deployment guide](docs/Agent-deployment.md) on the target computer. A general deployment includes teaching, media editing, transcription, and briefs. Use teaching-only steps when the user requests that scope.

1. Check Git, Node.js 24.9+, npm, native Python 3.11, FFmpeg, and FFprobe. Install missing prerequisites using the platform instructions. Use `npm.cmd` in Windows PowerShell.
2. Run `npm ci --include=optional`, `npm run setup:teaching -- <python>`, `npm run setup:integrations -- <python>`, and `npm run build`. The integration installer provisions the pinned Self Media Workbench, Hermes ACP, and multilingual faster-whisper weights, then saves the runtime paths.
3. In a fresh terminal, run `npm run doctor` and check DSH, Workbench, Hermes, teaching, and lesson readiness. Run `npm run test:teaching` and `npm run test:group` with synthetic material.
4. Start `npm start` and run `npm run verify:deployment` with the displayed URL. Verify the group workspace and folder picker in a graphical session, an interactive lesson and PPTX, an MP4 export, and a real local transcript. Use an existing user-authorized `DEEPSEEK_API_KEY` for text generation checks. Complete local checks while waiting for a missing key.
5. Resolve routine package, model-download, and path issues on the target computer. Report the actual address and tested features. Ask the user for genuinely missing input such as an API credential or a required system installer confirmation.
