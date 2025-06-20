import { filesize } from "filesize";
import pick from "lodash-es/pick";
import debounce from "lodash-es/debounce.js";
import { getOpenPromise } from "@converse/openpromise";
import { Model } from "@converse/skeletor";
import log from "@converse/log";
import { initStorage } from "../utils/storage.js";
import * as constants from "./constants.js";
import converse from "./api/public.js";
import api from "./api/index.js";
import { isNewMessage } from "../plugins/chat/utils.js";
import _converse from "./_converse.js";
import { MethodNotImplementedError } from "./errors.js";
import { sendMarker, sendReceiptStanza, sendRetractionMessage } from "./actions.js";
import { parseMessage } from "../plugins/chat/parsers";

const { Strophe, stx, u } = converse.env;

/**
 * Adds a messages collection to a model and various methods related to sending
 * and receiving chat messages.
 *
 * This model should be UX-agnostic, except when it comes to the rendering of
 * messages. So there's no assumption of uniformity with regards to UI elements
 * represented by this object.
 *
 * @template {import('./types').ModelExtender} T
 * @param {T} BaseModel
 */
export default function ModelWithMessages(BaseModel) {
    /**
     * @typedef {import('../plugins/chat/model').default} ChatBox
     * @typedef {import('../plugins/muc/muc').default} MUC
     * @typedef {import('../plugins/muc/parsers').MUCMessageAttributes} MUCMessageAttributes
     * @typedef {import('../shared/types').MessageAttributes} MessageAttributes
     * @typedef {import('./errors').StanzaParseError} StanzaParseError
     * @typedef {import('./message').default} BaseMessage
     * @typedef {import('strophe.js').Builder} Builder
     */

    return class ModelWithMessages extends BaseModel {
        /** @param {...any} args */
        constructor(...args) {
            super(args[0], args[1]);
            this.disable_mam = false;
        }

        async initialize() {
            super.initialize();

            this.initUI();
            this.initMessages();
            this.initNotifications();

            this.ui.on("change:scrolled", () => this.onScrolledChanged());
        }

        initNotifications() {
            this.notifications = new Model();
        }

        initUI() {
            this.ui = new Model();
        }

        /**
         * @returns {string}
         */
        getDisplayName() {
            return this.get("jid");
        }

        canPostMessages() {
            // Can be overridden in subclasses.
            return true;
        }

        /**
         * Queue the creation of a message, to make sure that we don't run
         * into a race condition whereby we're creating a new message
         * before the collection has been fetched.
         * @param {Object} attrs
         * @param {Object} options
         */
        async createMessage(attrs, options) {
            attrs.time = attrs.time || new Date().toISOString();
            await this.messages.fetched;
            return this.messages.create(attrs, options);
        }

        getMessagesCacheKey() {
            return `converse.messages-${this.get("jid")}-${_converse.session.get("bare_jid")}`;
        }

        getMessagesCollection() {
            return new _converse.exports.Messages();
        }

        getNotificationsText() {
            const { __ } = _converse;
            if (this.notifications?.get("chat_state") === constants.COMPOSING) {
                return __("%1$s is typing", this.getDisplayName());
            } else if (this.notifications?.get("chat_state") === constants.PAUSED) {
                return __("%1$s has stopped typing", this.getDisplayName());
            } else if (this.notifications?.get("chat_state") === constants.GONE) {
                return __("%1$s has gone away", this.getDisplayName());
            } else {
                return "";
            }
        }

        initMessages() {
            this.messages = this.getMessagesCollection();
            this.messages.fetched = getOpenPromise();
            this.messages.chatbox = this;
            initStorage(this.messages, this.getMessagesCacheKey());

            this.listenTo(this.messages, "add", (m) => this.onMessageAdded(m));
            this.listenTo(this.messages, "change:upload", (m) => this.onMessageUploadChanged(m));
            this.listenTo(this.messages, "change:correcting", (m) => this.onMessageCorrecting(m));
        }

        fetchMessages() {
            if (this.messages.fetched_flag) {
                log.info(`Not re-fetching messages for ${this.get("jid")}`);
                return;
            }
            this.messages.fetched_flag = true;
            const resolve = this.messages.fetched.resolve;
            this.messages.fetch({
                add: true,
                success: () => {
                    this.afterMessagesFetched();
                    resolve();
                },
                error: () => {
                    this.afterMessagesFetched();
                    resolve();
                },
            });
            return this.messages.fetched;
        }

        afterMessagesFetched() {
            this.pruneHistoryWhenScrolledDown();
            /**
             * Triggered whenever a {@link ModelWithMessages}
             * has fetched its messages from the local cache.
             * @event _converse#afterMessagesFetched
             * @type {ModelWithMessages}
             * @example _converse.api.listen.on('afterMessagesFetched', (model) => { ... });
             */
            api.trigger("afterMessagesFetched", this);
        }

        /**
         * @param {MessageAttributes|Error} _attrs_or_error
         */
        async onMessage(_attrs_or_error) {
            throw new MethodNotImplementedError("onMessage is not implemented");
        }

        /**
         * @param {BaseMessage} message
         * @param {MessageAttributes} attrs
         * @returns {object}
         */
        getUpdatedMessageAttributes(message, attrs) {
            if (!attrs.error_type && message.get("error_type") === "Decryption") {
                // Looks like we have a failed decrypted message stored, and now
                // we have a properly decrypted version of the same message.
                // See issue: https://github.com/conversejs/converse.js/issues/2733#issuecomment-1035493594
                return Object.assign({}, attrs, {
                    error_condition: undefined,
                    error_message: undefined,
                    error_text: undefined,
                    error_type: undefined,
                    is_archived: attrs.is_archived,
                    is_ephemeral: false,
                    is_error: false,
                });
            } else {
                return {
                    is_archived: attrs.is_archived,
                    time: attrs.time ? attrs.time : message.get("time"),
                };
            }
        }

        /**
         * @param {BaseMessage} message
         * @param {MessageAttributes} attrs
         */
        updateMessage(message, attrs) {
            const new_attrs = this.getUpdatedMessageAttributes(message, attrs);
            new_attrs && message.save(new_attrs);
        }

        /**
         * Determines whether the given attributes of an incoming message
         * represent a XEP-0308 correction and, if so, handles it appropriately.
         * @param {MessageAttributes|MUCMessageAttributes} attrs - Attributes representing a received
         *  message, as returned by {@link parseMessage}
         * @returns {Promise<BaseMessage|void>} Returns the corrected
         *  message or `undefined` if not applicable.
         */
        async handleCorrection(attrs) {
            if (!attrs.replace_id || !attrs.from) {
                return;
            }

            let query;
            if (attrs.type === "groupchat") {
                const { occupant_id, replace_id } = /** @type {MUCMessageAttributes} */ (attrs);
                query = occupant_id
                    ? ({ attributes: m }) => m.msgid === replace_id && m.occupant_id == occupant_id
                    : ({ attributes: m }) =>
                          m.msgid === attrs.replace_id && m.from === attrs.from && m.occupant_id == null;
            } else {
                query = ({ attributes: m }) =>
                    m.msgid === attrs.replace_id && m.from === attrs.from && m.occupant_id == null;
            }

            const message = this.messages.models.find(query);
            if (!message) {
                attrs["older_versions"] = {};
                return await this.createMessage(attrs); // eslint-disable-line no-return-await
            }

            const older_versions = message.get("older_versions") || {};
            if (attrs.time < message.get("time") && message.get("edited")) {
                // This is an older message which has been corrected afterwards
                older_versions[attrs.time] = attrs["message"];
                message.save({ "older_versions": older_versions });
            } else {
                // This is a correction of an earlier message we already received
                if (Object.keys(older_versions).length) {
                    older_versions[message.get("edited")] = message.getMessageText();
                } else {
                    older_versions[message.get("time")] = message.getMessageText();
                }
                attrs = Object.assign(attrs, { older_versions });
                delete attrs["msgid"]; // We want to keep the msgid of the original message
                delete attrs["id"]; // Delete id, otherwise a new cache entry gets created
                attrs["time"] = message.get("time");
                message.save(attrs);
            }
            return message;
        }

        /**
         * Queue an incoming `chat` message stanza for processing.
         * @param {MessageAttributes} attrs - A promise which resolves to the message attributes
         */
        queueMessage(attrs) {
            this.msg_chain = (this.msg_chain || this.messages.fetched)
                .then(() => this.onMessage(attrs))
                .catch((e) => log.error(e));
            return this.msg_chain;
        }

        /**
         * @param {MessageAttributes} [_attrs]
         * @return {Promise<MessageAttributes>}
         */
        async getOutgoingMessageAttributes(_attrs) {
            throw new MethodNotImplementedError("getOutgoingMessageAttributes is not implemented");
        }

        /**
         * Responsible for sending off a text message inside an ongoing chat conversation.
         * @param {Object} [attrs] - A map of attributes to be saved on the message
         * @returns {Promise<BaseMessage>}
         * @example
         *  const chat = api.chats.get('buddy1@example.org');
         *  chat.sendMessage({'body': 'hello world'});
         */
        async sendMessage(attrs) {
            await converse.emojis?.initialized_promise;

            if (!this.canPostMessages()) {
                log.warn("sendMessage was called but canPostMessages is false");
                return;
            }

            attrs = await this.getOutgoingMessageAttributes(attrs);
            let message = this.messages.findWhere("correcting");
            if (message) {
                const older_versions = message.get("older_versions") || {};
                const edited_time = message.get("edited") || message.get("time");
                older_versions[edited_time] = message.getMessageText();

                message.save({
                    ...["body", "is_only_emojis", "media_urls", "references", "is_encrypted"].reduce((obj, k) => {
                        if (attrs.hasOwnProperty(k)) obj[k] = attrs[k];
                        return obj;
                    }, {}),
                    ...{
                        correcting: false,
                        edited: new Date().toISOString(),
                        message: attrs.body,
                        ogp_metadata: [],
                        older_versions,
                        origin_id: u.getUniqueId(),
                        plaintext: attrs.is_encrypted ? attrs.message : undefined,
                        received: undefined,
                    },
                });
            } else {
                this.setEditable(attrs, new Date().toISOString());
                message = await this.createMessage(attrs);
            }

            try {
                const stanza = await this.createMessageStanza(message);
                api.send(stanza);
            } catch (e) {
                message.destroy();
                log.error(e);
                return;
            }

            /**
             * Triggered when a message is being sent out
             * @event _converse#sendMessage
             * @type {Object}
             * @param {Object} data
             * @property {(ChatBox|MUC)} data.chatbox
             * @property {(BaseMessage)} data.message
             */
            api.trigger("sendMessage", { "chatbox": this, message });
            return message;
        }

        /**
         * Retract one of your messages in this chat
         * @param {BaseMessage} message - The message which we're retracting.
         */
        retractOwnMessage(message) {
            const retraction_id = u.getUniqueId();
            sendRetractionMessage(this.get("jid"), message, retraction_id);
            message.save({
                "retracted": new Date().toISOString(),
                "retracted_id": message.get("origin_id"),
                "retraction_id": retraction_id,
                "is_ephemeral": true,
                "editable": false,
            });
        }

        /**
         * @param {File[]} files'
         */
        async sendFiles(files) {
            const { __, session } = _converse;
            const result = await api.disco.features.get(Strophe.NS.HTTPUPLOAD, session.get("domain"));
            const item = result.pop();
            if (!item) {
                this.createMessage({
                    "message": __("Sorry, looks like file upload is not supported by your server."),
                    "type": "error",
                    "is_ephemeral": true,
                });
                return;
            }
            const data = item.dataforms
                .where({ "FORM_TYPE": { "value": Strophe.NS.HTTPUPLOAD, "type": "hidden" } })
                .pop();
            const max_file_size = parseInt((data?.attributes || {})["max-file-size"]?.value, 10);
            const slot_request_url = item?.id;

            if (!slot_request_url) {
                this.createMessage({
                    "message": __("Sorry, looks like file upload is not supported by your server."),
                    "type": "error",
                    "is_ephemeral": true,
                });
                return;
            }
            Array.from(files).forEach(async (file) => {
                /**
                 * *Hook* which allows plugins to transform files before they'll be
                 * uploaded. The main use-case is to encrypt the files.
                 * @event _converse#beforeFileUpload
                 * @param {ChatBox|MUC} chat - The chat from which this file will be uploaded.
                 * @param {File} file - The file that will be uploaded
                 */
                file = await api.hook("beforeFileUpload", this, file);

                if (!isNaN(max_file_size) && file.size > max_file_size) {
                    const size = filesize(max_file_size);
                    const message = Array.isArray(size)
                        ? __("The size of your file, %1$s, exceeds the maximum allowed by your server.", file.name)
                        : __(
                              "The size of your file, %1$s, exceeds the maximum allowed by your server, which is %2$s.",
                              file.name,
                              size
                          );
                    return this.createMessage({
                        message,
                        type: "error",
                        is_ephemeral: true,
                    });
                } else {
                    const initial_attrs = await this.getOutgoingMessageAttributes();
                    const attrs = Object.assign(initial_attrs, {
                        "file": true,
                        "progress": 0,
                        "slot_request_url": slot_request_url,
                    });
                    this.setEditable(attrs, new Date().toISOString());
                    const message = await this.createMessage(attrs, { "silent": true });
                    message.file = file;
                    this.messages.trigger("add", message);
                    message.getRequestSlotURL();
                }
            });
        }

        /**
         * Responsible for setting the editable attribute of messages.
         * If api.settings.get('allow_message_corrections') is "last", then only the last
         * message sent from me will be editable. If set to "all" all messages
         * will be editable. Otherwise no messages will be editable.
         * @param {Object} attrs An object containing message attributes.
         * @param {String} send_time - time when the message was sent
         */
        setEditable(attrs, send_time) {
            if (attrs.is_headline || u.isEmptyMessage(attrs) || attrs.sender !== "me") {
                return;
            }
            if (api.settings.get("allow_message_corrections") === "all") {
                attrs.editable = !(attrs.file || attrs.retracted || "oob_url" in attrs);
            } else if (api.settings.get("allow_message_corrections") === "last" && send_time > this.get("time_sent")) {
                this.set({ "time_sent": send_time });
                this.messages.findWhere({ "editable": true })?.save({ "editable": false });
                attrs.editable = !(attrs.file || attrs.retracted || "oob_url" in attrs);
            }
        }

        /**
         * Mutator for setting the chat state of this chat session.
         * Handles clearing of any chat state notification timeouts and
         * setting new ones if necessary.
         * Timeouts are set when the  state being set is COMPOSING or PAUSED.
         * After the timeout, COMPOSING will become PAUSED and PAUSED will become INACTIVE.
         * See XEP-0085 Chat State Notifications.
         * @param {string} state - The chat state (consts ACTIVE, COMPOSING, PAUSED, INACTIVE, GONE)
         * @param {object} [options]
         */
        setChatState(state, options) {
            if (this.chat_state_timeout !== undefined) {
                clearTimeout(this.chat_state_timeout);
                delete this.chat_state_timeout;
            }
            if (state === constants.COMPOSING) {
                this.chat_state_timeout = setTimeout(
                    this.setChatState.bind(this),
                    _converse.TIMEOUTS.PAUSED,
                    constants.PAUSED
                );
            } else if (state === constants.PAUSED) {
                this.chat_state_timeout = setTimeout(
                    this.setChatState.bind(this),
                    _converse.TIMEOUTS.INACTIVE,
                    constants.INACTIVE
                );
            }
            this.set("chat_state", state, options);
            return this;
        }

        /**
         * @param {BaseMessage} message
         */
        onMessageAdded(message) {
            if (
                api.settings.get("prune_messages_above") &&
                (api.settings.get("pruning_behavior") === "scrolled" || !this.ui.get("scrolled")) &&
                !u.isEmptyMessage(message)
            ) {
                this.debouncedPruneHistory();
            }
        }

        /**
         * @param {BaseMessage} message
         */
        async onMessageUploadChanged(message) {
            if (message.get("upload") === constants.SUCCESS) {
                const attrs = {
                    "body": message.get("body"),
                    "spoiler_hint": message.get("spoiler_hint"),
                    "oob_url": message.get("oob_url"),
                };
                await this.sendMessage(attrs);
                message.destroy();
            }
        }

        /**
         * @param {BaseMessage} message
         */
        onMessageCorrecting(message) {
            if (message.get('correcting')) {
                this.save({ correcting: message.get('id'), draft: u.prefixMentions(message) });
            } else {
                this.save({ correcting: undefined, draft: undefined });
            }
        }

        onScrolledChanged() {
            if (!this.ui.get("scrolled")) {
                this.clearUnreadMsgCounter();
                this.pruneHistoryWhenScrolledDown();
            }
        }

        pruneHistoryWhenScrolledDown() {
            if (
                api.settings.get("prune_messages_above") &&
                api.settings.get("pruning_behavior") === "unscrolled" &&
                !this.ui.get("scrolled")
            ) {
                this.debouncedPruneHistory();
            }
        }

        /**
         * @param {MessageAttributes} attrs
         * @returns {Promise<boolean>}
         */
        shouldShowErrorMessage(attrs) {
            const msg = this.getMessageReferencedByError(attrs);
            if (!msg && attrs.chat_state) {
                // If the error refers to a message not included in our store,
                // and it has a chat state tag, we assume that this was a
                // CSI message (which we don't store).
                // See https://github.com/conversejs/converse.js/issues/1317
                return;
            }
            // Gets overridden
            // Return promise because subclasses need to return promises
            return Promise.resolve(true);
        }

        async clearMessages() {
            try {
                await this.messages.clearStore();
            } catch (e) {
                this.messages.trigger("reset");
                log.error(e);
            } finally {
                // No point in fetching messages from the cache if it's been cleared.
                // Make sure to resolve the fetched promise to avoid freezes.
                this.messages.fetched.resolve();
            }
        }

        editEarlierMessage() {
            let message;
            let idx = this.messages.findLastIndex("correcting");
            if (idx >= 0) {
                this.messages.at(idx).save("correcting", false);
                while (idx > 0) {
                    idx -= 1;
                    const candidate = this.messages.at(idx);
                    if (candidate.get("editable")) {
                        message = candidate;
                        break;
                    }
                }
            }
            message =
                message ||
                this.messages
                    .filter({ sender: "me" })
                    .reverse()
                    .find((m) => m.get("editable"));

            message?.save("correcting", true);
        }

        editLaterMessage() {
            let message;
            let idx = this.messages.findLastIndex("correcting");
            if (idx >= 0) {
                this.messages.at(idx).save("correcting", false);
                while (idx < this.messages.length - 1) {
                    idx += 1;
                    const candidate = this.messages.at(idx);
                    if (candidate.get("editable")) {
                        message = candidate;
                        message.save("correcting", true);
                        break;
                    }
                }
            }
            return message;
        }

        getOldestMessage() {
            for (let i = 0; i < this.messages.length; i++) {
                const message = this.messages.at(i);
                const messageType = message.get('type');
                if (messageType === this.get('message_type') || messageType === 'normal') {
                    return message;
                }
            }
        }

        getMostRecentMessage() {
            for (let i = this.messages.length - 1; i >= 0; i--) {
                const message = this.messages.at(i);
                const messageType = message.get('type');
                if (messageType === this.get('message_type') || messageType === 'normal') {
                    return message;
                }
            }
        }

        /**
         * Given an error `<message>` stanza's attributes, find the saved message model which is
         * referenced by that error.
         * @param {object} attrs
         */
        getMessageReferencedByError(attrs) {
            const id = attrs.msgid;
            return id && this.messages.models.find((m) => [m.get("msgid"), m.get("retraction_id")].includes(id));
        }

        /**
         * Looks whether we already have a retraction for this
         * incoming message. If so, it's considered "dangling" because it
         * probably hasn't been applied to anything yet, given that the
         * relevant message is only coming in now.
         * @param {object} attrs - Attributes representing a received
         *  message, as returned by {@link parseMessage}
         * @returns {BaseMessage|null}
         */
        findDanglingRetraction(attrs) {
            if (!attrs.origin_id || !this.messages.length) {
                return null;
            }
            // Only look for dangling retractions if there are newer
            // messages than this one, since retractions come after.
            if (this.messages.last().get("time") > attrs.time) {
                // Search from latest backwards
                const messages = Array.from(this.messages.models);
                messages.reverse();
                return messages.find(
                    ({ attributes }) =>
                        attributes.retracted_id === attrs.origin_id &&
                        attributes.from === attrs.from &&
                        !attributes.moderated_by
                );
            }
            return null;
        }

        /**
         * Returns an already cached message (if it exists) based on the
         * passed in attributes map.
         * @param {object} attrs - Attributes representing a received
         *  message, as returned by {@link parseMessage}
         * @returns {BaseMessage}
         */
        getDuplicateMessage(attrs) {
            const queries = [
                ...this.getStanzaIdQueryAttrs(attrs),
                this.getOriginIdQueryAttrs(attrs),
                this.getMessageBodyQueryAttrs(attrs),
            ].filter((s) => s);

            return this.messages.models.find(
                /** @param {BaseMessage} m */
                (m) => queries.find((q) => Object.keys(q).every((k) => m.get(k) === q[k]))
            );
        }

        /**
         * @param {object} attrs - Attributes representing a received
         */
        getOriginIdQueryAttrs(attrs) {
            return attrs.origin_id && { origin_id: attrs.origin_id, from: attrs.from };
        }

        /**
         * @param {object} attrs - Attributes representing a received
         */
        getStanzaIdQueryAttrs(attrs) {
            const keys = Object.keys(attrs).filter((k) => k.startsWith("stanza_id "));
            return keys.map((key) => {
                const by_jid = key.replace(/^stanza_id /, "");
                const query = {};
                query[`stanza_id ${by_jid}`] = attrs[key];
                return query;
            });
        }

        /**
         * @param {object} attrs - Attributes representing a received
         */
        getMessageBodyQueryAttrs(attrs) {
            if (attrs.msgid) {
                const query = {
                    from: attrs.from,
                    msgid: attrs.msgid,
                };
                // XXX: Need to take XEP-428 <fallback> into consideration
                if (!attrs.is_encrypted && attrs.body) {
                    // We can't match the message if it's a reflected
                    // encrypted message (e.g. via MAM or in a MUC)
                    query["body"] = attrs.body;
                }
                return query;
            }
        }

        /**
         * Given the passed in message object, send a XEP-0333 chat marker.
         * @param {BaseMessage} msg
         * @param {('received'|'displayed'|'acknowledged')} [type='displayed']
         * @param {boolean} [force=false] - Whether a marker should be sent for the
         *  message, even if it didn't include a `markable` element.
         */
        async sendMarkerForMessage(msg, type = "displayed", force = false) {
            if (!msg || msg?.get("type") === "groupchat" || !api.settings.get("send_chat_markers").includes(type)) {
                return;
            }

            // Don't send chat markers to contacts that are not subscribed
            // to our presence.
            const contact = await api.contacts.get(this.get("jid"));
            const subscription = contact?.get("subscription");
            if (!contact || subscription === "none" || subscription === "to") {
                return;
            }

            if (msg?.get("is_markable") || force) {
                const from_jid = Strophe.getBareJidFromJid(msg.get("from"));
                sendMarker(from_jid, msg.get("msgid"), type, msg.get("type"));
            }
        }

        /**
         * Given a newly received {@link BaseMessage} instance,
         * update the unread counter if necessary.
         * @param {BaseMessage} message
         */
        handleUnreadMessage(message) {
            if (!message?.get("body")) {
                return;
            }

            if (isNewMessage(message)) {
                if (message.get("sender") === "me") {
                    // We remove the "scrolled" flag so that the chat area
                    // gets scrolled down. We always want to scroll down
                    // when the user writes a message as opposed to when a
                    // message is received.
                    this.ui.set("scrolled", false);
                } else if (this.isHidden()) {
                    this.incrementUnreadMsgsCounter(message);
                } else {
                    this.sendMarkerForMessage(message);
                }
            }
        }

        /**
         * @param {BaseMessage} message
         * @param {MessageAttributes} attrs
         */
        async getErrorAttributesForMessage(message, attrs) {
            const { __ } = _converse;
            const new_attrs = {
                editable: false,
                error: attrs.error,
                error_condition: attrs.error_condition,
                error_text: attrs.error_text,
                error_type: attrs.error_type,
                is_error: true,
            };
            if (attrs.msgid === message.get("retraction_id")) {
                // The error message refers to a retraction
                new_attrs.retraction_id = undefined;
                if (!attrs.error) {
                    if (attrs.error_condition === "forbidden") {
                        new_attrs.error = __("You're not allowed to retract your message.");
                    } else {
                        new_attrs.error = __("Sorry, an error occurred while trying to retract your message.");
                    }
                }
            } else if (!attrs.error) {
                if (attrs.error_condition === "forbidden") {
                    new_attrs.error = __("You're not allowed to send a message.");
                } else {
                    new_attrs.error = __("Sorry, an error occurred while trying to send your message.");
                }
            }
            /**
             * *Hook* which allows plugins to add application-specific attributes
             * @event _converse#getErrorAttributesForMessage
             */
            return await api.hook("getErrorAttributesForMessage", attrs, new_attrs);
        }

        /**
         * @param {Element} stanza
         */
        async handleErrorMessageStanza(stanza) {
            const attrs_or_error = await parseMessage(stanza);
            if (u.isErrorObject(attrs_or_error)) {
                const { stanza, message } = /** @type {StanzaParseError} */ (attrs_or_error);
                if (stanza) log.error(stanza);
                return log.error(message);
            }

            const attrs = /** @type {MessageAttributes} */ (attrs_or_error);
            if (!(await this.shouldShowErrorMessage(attrs))) {
                return;
            }

            const message = this.getMessageReferencedByError(attrs);
            if (message) {
                const new_attrs = await this.getErrorAttributesForMessage(message, attrs);
                message.save(new_attrs);
            } else {
                this.createMessage(attrs);
            }
        }

        /**
         * @param {BaseMessage} message
         */
        incrementUnreadMsgsCounter(message) {
            const settings = {
                "num_unread": this.get("num_unread") + 1,
            };
            if (this.get("num_unread") === 0) {
                settings["first_unread_id"] = message.get("id");
            }
            this.save(settings);
        }

        clearUnreadMsgCounter() {
            if (this.get("num_unread") > 0) {
                this.sendMarkerForMessage(this.messages.last());
            }
            u.safeSave(this, { num_unread: 0 });
        }

        /**
         * Handles message retraction based on the passed in attributes.
         * @param {MessageAttributes} attrs - Attributes representing a received
         *  message, as returned by {@link parseMessage}
         * @returns {Promise<Boolean>} Returns `true` or `false` depending on
         *  whether a message was retracted or not.
         */
        async handleRetraction(attrs) {
            const RETRACTION_ATTRIBUTES = ["retracted", "retracted_id", "editable"];
            if (attrs.retracted) {
                if (attrs.is_tombstone) return false;

                for (const m of this.messages.models) {
                    if (m.get("from") !== attrs.from) continue;
                    if (m.get("origin_id") === attrs.retracted_id || m.get("msgid") === attrs.retracted_id) {
                        m.save(pick(attrs, RETRACTION_ATTRIBUTES));
                        return true;
                    }
                }

                attrs["dangling_retraction"] = true;
                await this.createMessage(attrs);
                return true;
            } else {
                // Check if we have dangling retraction
                const message = this.findDanglingRetraction(attrs);
                if (message) {
                    const retraction_attrs = pick(message.attributes, RETRACTION_ATTRIBUTES);
                    const new_attrs = Object.assign({ dangling_retraction: false }, attrs, retraction_attrs);
                    delete new_attrs["id"]; // Delete id, otherwise a new cache entry gets created
                    message.save(new_attrs);
                    return true;
                }
            }
            return false;
        }

        /**
         * @param {MessageAttributes} attrs
         */
        handleReceipt(attrs) {
            if (attrs.sender === "them") {
                if (attrs.is_valid_receipt_request) {
                    sendReceiptStanza(attrs.from, attrs.msgid);
                } else if (attrs.receipt_id) {
                    const message = this.messages.findWhere({ "msgid": attrs.receipt_id });
                    if (message && !message.get("received")) {
                        message.save({ "received": new Date().toISOString() });
                    }
                    return true;
                }
            }
            return false;
        }

        /**
         * Given a {@link BaseMessage} return the XML stanza that represents it.
         * @method ChatBox#createMessageStanza
         * @param {BaseMessage} message - The message object
         */
        async createMessageStanza(message) {
            const {
                body,
                edited,
                is_encrypted,
                is_spoiler,
                msgid,
                oob_url,
                origin_id,
                references,
                spoiler_hint,
                type,
            } = message.attributes;

            const stanza = stx`
                <message xmlns="jabber:client"
                        from="${message.get("type") === "groupchat" ? api.connection.get().jid : message.get("from")}"
                        to="${message.get("to") || this.get("jid")}"
                        type="${this.get("message_type")}"
                        id="${(edited && u.getUniqueId()) || msgid}">
                    ${body ? stx`<body>${body}</body>` : ""}
                    <active xmlns="${Strophe.NS.CHATSTATES}"/>
                    ${type === "chat" ? stx`<request xmlns="${Strophe.NS.RECEIPTS}"></request>` : ""}
                    ${!is_encrypted && oob_url ? stx`<x xmlns="${Strophe.NS.OUTOFBAND}"><url>${oob_url}</url></x>` : ""}
                    ${!is_encrypted && is_spoiler ? stx`<spoiler xmlns="${Strophe.NS.SPOILER}">${spoiler_hint ?? ""}</spoiler>` : ""}
                    ${
                        !is_encrypted
                            ? references?.map(
                                  (ref) => stx`<reference xmlns="${Strophe.NS.REFERENCE}"
                                                begin="${ref.begin}"
                                                end="${ref.end}"
                                                type="${ref.type}"
                                                uri="${ref.uri}"></reference>`
                              )
                            : ""
                    }
                    ${edited ? stx`<replace xmlns="${Strophe.NS.MESSAGE_CORRECT}" id="${msgid}"></replace>` : ""}
                    ${origin_id ? stx`<origin-id xmlns="${Strophe.NS.SID}" id="${origin_id}"></origin-id>` : ""}
                </message>`;

            /**
             * *Hook* which allows plugins to update an outgoing message stanza
             * @event _converse#createMessageStanza
             * @param {ChatBox|MUC} chat - The chat from
             *      which this message stanza is being sent.
             * @param {Object} data - BaseMessage data
             * @param {BaseMessage} data.message
             *      The message object from which the stanza is created and which gets persisted to storage.
             * @param {Builder} data.stanza
             *      The stanza that will be sent out, as a Strophe.Builder object.
             *      You can use the Strophe.Builder functions to extend the stanza.
             *      See http://strophe.im/strophejs/doc/1.4.3/files/strophe-umd-js.html#Strophe.Builder.Functions
             */
            const data = await api.hook("createMessageStanza", this, { message, stanza });
            return data.stanza;
        }

        /**
         * Prunes the message history to ensure it does not exceed the maximum
         * number of messages specified in the settings.
         */
        pruneHistory() {
            const max_history = api.settings.get("prune_messages_above");
            if (max_history && typeof max_history === "number") {
                if (this.messages.length > max_history) {
                    const non_empty_messages = this.messages.filter((m) => !u.isEmptyMessage(m));
                    if (non_empty_messages.length > max_history) {
                        while (non_empty_messages.length > max_history) {
                            non_empty_messages.shift().destroy();
                        }
                        /**
                         * Triggered once the message history has been pruned, i.e.
                         * once older messages have been removed to keep the
                         * number of messages below the value set in `prune_messages_above`.
                         */
                        this.trigger("historyPruned");
                    }
                }
            }
        }
        debouncedPruneHistory = debounce(() => this.pruneHistory(), 500, { maxWait: 2000 });

        isScrolledUp() {
            return this.ui.get("scrolled");
        }

        /**
         * Indicates whether the chat is hidden and therefore
         * whether a newly received message will be visible to the user or not.
         * @returns {boolean}
         */
        isHidden() {
            return this.get("hidden") || this.isScrolledUp() || document.hidden;
        }
    };
}
