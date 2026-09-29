// Test targets for rules/javascript.yml, annotated with the rule IDs each
// line must or must not match.
const cp = require("child_process");
const { exec, execFile } = require("node:child_process");

function evalCases(req) {
	// ruleid: js-eval-dynamic
	eval(req.query.code);
	// ok: js-eval-dynamic
	eval("1 + 1");
}

function functionCases(body) {
	// ruleid: js-new-function-dynamic
	const f = new Function("a", body);
	// ok: js-new-function-dynamic
	const g = new Function("a", "return a");
	return [f, g];
}

function commandCases(name) {
	// ruleid: js-child-process-command-injection
	cp.exec(`git log ${name}`);
	// ruleid: js-child-process-command-injection
	cp.execSync("ls " + name);
	// ok: js-child-process-command-injection
	cp.exec("git status");
	// ok: js-child-process-command-injection
	cp.execFile("git", ["log", name]);
	// ruleid: js-child-process-command-injection-import
	exec(`rm -rf ${name}`);
	// ok: js-child-process-command-injection-import
	execFile("rm", ["-rf", name]);
	// ok: js-child-process-command-injection-import
	/x/.exec(`${name}`);
}

function spawnCases(command, args) {
	// ruleid: js-spawn-shell-dynamic
	cp.spawnSync(command, args, { shell: true });
	// ok: js-spawn-shell-dynamic
	cp.spawnSync("npm test", { shell: true });
	// ok: js-spawn-shell-dynamic
	cp.spawnSync(command, args, { stdio: "inherit" });
}

function tlsCases(https) {
	// ruleid: js-tls-verification-disabled
	https.request({ host: "example.com", rejectUnauthorized: false });
	// ok: js-tls-verification-disabled
	https.request({ host: "example.com", rejectUnauthorized: true });
	// ruleid: js-tls-verification-disabled
	process.env.NODE_TLS_REJECT_UNAUTHORIZED = "0";
}

function jwtCases(jwt, token, key) {
	// ruleid: js-jwt-none-algorithm
	jwt.verify(token, key, { algorithms: ["HS256", "none"] });
	// ok: js-jwt-none-algorithm
	jwt.verify(token, key, { algorithms: ["RS256"] });
}

function domCases(el, html) {
	// ruleid: js-dom-html-sink
	el.innerHTML = html;
	// ok: js-dom-html-sink
	el.innerHTML = "<p>Loading</p>";
	// ruleid: js-dom-html-sink
	document.write(html);
	// ok: js-dom-html-sink
	el.textContent = html;
}

function expressCases(app, cors) {
	app.get("/go", (req, res) => {
		// ruleid: express-open-redirect
		res.redirect(req.query.next);
		// ok: express-open-redirect
		res.redirect("/home");
	});
	app.get("/echo", (req, res) => {
		// ruleid: express-reflected-input
		res.send(req.query.name);
		// ok: express-reflected-input
		res.json({ name: req.query.name });
	});
	// ruleid: express-cors-any-origin-with-credentials
	app.use(cors({ origin: true, credentials: true }));
	// ok: express-cors-any-origin-with-credentials
	app.use(cors({ origin: ["https://example.com"], credentials: true }));
}

function nextCases(searchParams, redirect) {
	// ruleid: nextjs-public-env-secret
	const secret = process.env.NEXT_PUBLIC_STRIPE_SECRET;
	// ok: nextjs-public-env-secret
	const site = process.env.NEXT_PUBLIC_SITE_URL;
	// ruleid: nextjs-open-redirect
	redirect(searchParams.get("next"));
	// ok: nextjs-open-redirect
	redirect("/dashboard");
	return [secret, site];
}
