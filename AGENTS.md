# Deploy Hyper Bot

For a request to deploy this repository on the user's Windows or macOS computer, follow [Agent 部署说明](docs/Agent-deployment.md). Run the commands on the target computer and use its native CPU architecture.

1. Check for Git, Node.js 24.9 or newer, npm, and Python 3.11 or newer. Install any missing prerequisites using the platform instructions. Use Python 3.14 for new installs. On Windows PowerShell, use `npm.cmd`.
2. In this repository, install the locked Node dependencies, run the `setup:teaching` script with the selected Python interpreter, and build the app.
3. Run `npm run doctor` and confirm `teaching.ok` and `teaching.lessons.ok`. Run `npm run test:teaching` to exercise the bundled service with synthetic material. Open the Bot market's English teaching category.
4. Start the local service with `npm start` and run `npm run verify:deployment -- http://127.0.0.1:4367` from a second terminal, using the actual loopback address printed by startup. Confirm the live HTML, JS, CSS, and English teaching catalog before reporting it ready. Use a fresh workspace for tests. The optional teaching assistant reads `DEEPSEEK_API_KEY` from the service's launch environment.

The app includes the teaching runtime. Use the default teaching configuration for a fresh standalone deployment. See [Agent 部署说明](docs/Agent-deployment.md) for platform commands and acceptance checks.
