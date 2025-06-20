import { _converse, api, converse, constants } from '@converse/headless';
import { html } from 'lit';

const { Strophe } = converse.env;
const { ANONYMOUS } = constants;

/**
 * @param {import('../controlbox').default} el
 */
function whenNotConnected(el) {
    const is_fullscreen = api.settings.get('view_mode') === 'fullscreen';
    const connection_status = _converse.state.connfeedback.get('connection_status');
    const connecting = [Strophe.Status.RECONNECTING, Strophe.Status.CONNECTING].includes(connection_status);
    return html`
        <div class="controlbox-pane d-flex flex-column justify-content-between">
            ${is_fullscreen ? html`<converse-controlbox-navbar></converse-controlbox-navbar>` : ''}
            <converse-brand-logo></converse-brand-logo>
            ${connecting
                ? html`<converse-spinner class="vertically-centered fade-in" />`
                : el.model.get('active-form') === 'register'
                  ? html`<converse-registration-form class="fade-in" />`
                  : html`<converse-login-form class="fade-in" />`}
            ${is_fullscreen ? html`<converse-footer></converse-footer>` : ''}
        </div>
    `;
}

/**
 * @param {import('../controlbox').default} el
 */
export default (el) => {
    return html`<div class="flyout box-flyout">
        <converse-dragresize></converse-dragresize>
        ${el.model.get('connected')
            ? html`<converse-user-profile />`
            : html`<converse-controlbox-buttons class="controlbox-padded" />`}
        ${el.model.get('connected')
            ? html`<div class="controlbox-pane">
                  <converse-headlines-feeds-list class="controlbox-section"></converse-headlines-feeds-list>
                  <div id="chatrooms" class="controlbox-section"><converse-rooms-list /></div>
                  ${api.settings.get('authentication') === ANONYMOUS
                      ? ''
                      : html`<div id="converse-roster" class="controlbox-section"><converse-roster /></div>`}
              </div>`
            : whenNotConnected(el)}
    </div>`;
};
