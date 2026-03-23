export class ScrollFader extends HTMLElement {
	connectedCallback() {
		const top = document.createElement("div");
		const bottom = document.createElement("div");
		const inner = document.createElement("div");
		top.className = "scroll-shadow scroll-shadow-top";
		bottom.className = "scroll-shadow scroll-shadow-bottom";
		inner.className = "scroll-fader-inner";

		this.appendChild(top);
		this.appendChild(bottom);
		this.appendChild(inner);

		this._shadows = { top, bottom };
		this._inner = inner;

		inner.addEventListener("scroll", () => this._update());
		new MutationObserver(() => this._update()).observe(inner, {
			childList: true,
			subtree: true,
		});
	}

	_update() {
		const { scrollTop, scrollHeight, clientHeight } = this._inner;
		const maxScroll = scrollHeight - clientHeight;
		const scrolled = Math.abs(scrollTop);
		const atBottom = scrolled <= 2;
		const atTop = maxScroll <= 2 || scrolled >= maxScroll - 4;
		this._shadows.top.classList.toggle("visible", !atTop);
		this._shadows.bottom.classList.toggle("visible", !atBottom);
	}

	get inner() {
		return this._inner;
	}
}

customElements.define("scroll-fader", ScrollFader);
