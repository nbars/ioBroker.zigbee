'use strict';

const ZigbeeHerdsman = require('zigbee-herdsman');


class Developer {
    constructor(adapter) {
        this.adapter = adapter;
        this.adapter.on("message", this.onMessage.bind(this));
    }

    start(zbController, stController) {
        this.zbController = zbController;
        this.stController = stController;
    }

    stop() {
        delete this.zbController;
        delete this.stController;
    }

    info(msg) {
        this.adapter.log.info(msg);
    }

    error(msg) {
        this.adapter.log.error(msg);
    }

    debug(msg) {
        this.adapter.log.debug(msg);
    }

    /**
     * @param {ioBroker.Message} obj
     */
    onMessage(obj) {
        if (typeof obj === "object" && obj.command) {
            switch (obj.command) {
                case 'reset':
                    this.zbController.reset(obj.message.mode, function (err, data) {
                        this.adapter.sendTo(obj.from, obj.command, err, obj.callback);
                    }.bind(this));
                    break;
                case 'sendToZigbee':
                    this.sendToZigbee(obj);
                    break;
                case 'getLibData':
                    // e.g. zcl lists
                    this.getLibData(obj);
                    break;
            }
        }
    }

    getLibData(obj) {
        const key = obj.message.key;
        const zcl = ZigbeeHerdsman.Zcl;
        const result = {};
        if (key === 'cidList') {
            result.list = zcl.Cluster;
        } else if (key === 'attrIdList') {
            const cid = obj.message.cid;
            result.list = zcl.Utils.getCluster(parseInt(cid)).attributes;
        } else if (key === 'cmdListFoundation') {
            result.list = zcl.Foundation;
        } else if (key === 'cmdListFunctional') {
            result.list = null;
            const cluster = zcl.Utils.getCluster(parseInt(obj.message.cid));
            if (typeof cluster != 'undefined') {
                const extraCmd = cluster.cmd;
                result.list = extraCmd !== null ? extraCmd._enumMap : null;
            }
        } else if (key === 'respCodes') {
            result.list = zcl.Status;
        } else if (key === 'typeList') {
            result.list = zcl.DataType;
        } else {
            return;
        }
        result.key = key;
        this.adapter.sendTo(obj.from, obj.command, result, obj.callback);
    }

    sendToZigbee(obj) {
        const zcl = ZigbeeHerdsman.Zcl;
        const devId = '0x' + obj.message.id.replace(this.adapter.namespace + '.', '');
        const ep = obj.message.ep ? parseInt(obj.message.ep) : null;
        const cid = obj.message.cid;
        const cmdType = obj.message.cmdType;
        let cmd;
        let zclData = obj.message.zclData;
        if (cmdType === 'functional') {
            cmd = zcl.Utils.getCluster(parseInt(cid)).getCommand(parseInt(obj.message.cmd));
        } else if (cmdType === 'foundation') {
            cmd = zcl.Utils.getGlobalCommand(parseInt(obj.message.cmd));
            if (!Array.isArray(zclData)) {
                // wrap object in array
                zclData = [zclData];
            }
        } else {
            this.adapter.sendTo(obj.from, obj.command, {localErr: 'Invalid cmdType'}, obj.callback);
            return;
        }

        const cfg = obj.message.hasOwnProperty('cfg') ? obj.message.cfg : null;

        for (let i = 0; i < zclData.length; i++) {
            const zclItem = zclData[i];
            // convert string items to number if needed
            if (typeof zclItem.attrId == 'string') {
                const intId = parseInt(zclItem.attrId);
                zclData[i].attrId = !isNaN(intId) ? intId : zclId.attr(cid, zclItem.attrId).value;
            }
            if (typeof zclItem.dataType == 'string') {
                const intType = parseInt(zclItem.dataType);
                zclData[i].dataType = !isNaN(intType) ? intType : zclId.attr(cid, zclItem.dataType).value;
            }
        }
        const publishTarget = this.zbController.getDevice(devId) ? devId : this.zbController.getGroup(parseInt(devId));
        if (!publishTarget) {
            this.adapter.sendTo(obj.from, obj.command, {localErr: 'Device or group ' + devId + ' not found!'}, obj.callback);
            return;
        }
        if (!cid || !cmd) {
            this.adapter.sendTo(obj.from, obj.command, {localErr: 'Incomplete data (cid or cmd)'}, obj.callback);
            return;
        }
        this.debug('Ready to send (ep: ' + ep + ', cid: ' + cid + ' cmd, ' + cmd + ' zcl: ' + JSON.stringify(zclData) + ')');

        try {
            this.zbController.publish(publishTarget, cid, cmd, zclData, cfg, ep, cmdType, (err, msg) => {
                // map err and msg in one object for sendTo
                const result = {};
                result.msg = msg;
                if (err) {
                    // err is an instance of Error class, it cannot be forwarded to sendTo, just get message (string)
                    result.err = err.message;
                }
                this.adapter.sendTo(obj.from, obj.command, result, obj.callback);
            });
        } catch (exception) {
            // report exceptions
            // happens for example if user tries to send write command but did not provide value/type
            // we dont want to check this errors ourselfs before publish, but let shepherd handle this
            this.error('SendToZigbee failed! (' + exception + ')');
            this.adapter.sendTo(obj.from, obj.command, {err: exception}, obj.callback);

            // Note: zcl-packet/lib/foundation.js throws correctly
            // 'Error: Payload of commnad: write must have dataType property.',
            // but only at first time. If user sends same again no exception anymore
            // not sure if bug in zigbee-shepherd or zcl-packet
        }
    }
}

module.exports = Developer;