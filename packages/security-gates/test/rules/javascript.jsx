// Test targets for the React rules in rules/javascript.yml.
export function Comment({ body }) {
	// ruleid: react-dangerously-set-inner-html
	return <div dangerouslySetInnerHTML={{ __html: body }} />;
}

export function Notice() {
	// ok: react-dangerously-set-inner-html
	return <div dangerouslySetInnerHTML={{ __html: "<b>Note</b>" }} />;
}
