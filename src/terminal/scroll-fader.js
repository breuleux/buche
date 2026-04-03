export class ScrollFader extends HTMLElement {
  constructor() {
    super();
    this._inner = document.createElement("div");
    this._inner.className = "scroll-fader-inner";
  }

  connectedCallback() {
    if (this._initialized) {
      return;
    }
    this._initialized = true;

    const top = document.createElement("div");
    const bottom = document.createElement("div");
    top.className = "scroll-shadow scroll-shadow-top";
    bottom.className = "scroll-shadow scroll-shadow-bottom";

    this.appendChild(top);
    this.appendChild(bottom);
    this.appendChild(this._inner);

    this._shadows = { top, bottom };

    this._inner.addEventListener("scroll", () => this._update());
    new MutationObserver(() => this._update()).observe(this._inner, {
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
