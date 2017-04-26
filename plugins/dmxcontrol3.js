const xml2js = require('xml2js');

module.exports.name = 'DMXControl 3';
module.exports.version = '0.1.0';


function capitalize(string) {
  return string.charAt(0).toUpperCase() + string.slice(1);
}

function logXML(obj) {
  var builder = new xml2js.Builder({
    headless: true
  });
  var xml = builder.buildObject(obj);
  console.log(xml);
}


module.exports.import = function importDmxControl3(str, filename, resolve, reject) {
  new xml2js.Parser().parseString(str, (parseError, xml) => {
    if (parseError) {
      return reject(`Error parsing '${filename}' as XML.\n` + parseError.toString());
    }

    let out = {
      manufacturers: {},
      fixtures: {},
      warnings: {}
    };

    try {
      const device = xml.device;
      const info = device.information[0];
      const manName = info.vendor[0];
      const manKey = manName.toLowerCase().replace(/[^a-z0-9\-]+/g, '-');
      out.manufacturers[manKey] = {
        name: manName
      };

      // TODO: check if "modell" is really generated by DDFCreator
      // or if it only was a typo of myself
      const fixName = 'model' in info ? info.model[0] : info.modell[0];
      const fixKey = manKey + '/' + fixName.toLowerCase().replace(/[^a-z0-9\-]+/g, '-');
      out.warnings[fixKey] = [];

      const timestamp = new Date().toISOString().split('T')[0];
      let fix = {
        name: fixName,
        shortName: fixKey,
        categories: [],
        meta: {
          createDate: timestamp,
          lastModifyDate: timestamp
        },
        availableChannels: {},
        modes: [{
          name: 'Default',
          channels: []
        }]
      };

      if (info.author) {
        fix.meta.authors = [info.author[0]];
      }

      if (info.mode) {
        fix.modes[0].name = info.mode[0];
      }

      // make sure that channels.length is dmxaddresscount.
      // (undefined channels will later be set to null)
      if (device.$.dmxaddresscount) {
        fix.modes[0].channels[device.$.dmxaddresscount - 1] = null;
      }


      const warnUnknownAttributes = function(nodeName, node, knownAttributes) {
        if ('$' in node) {
          for (const attr in node.$) {
            if (!knownAttributes.includes(attr)) {
              out.warnings[fixKey].push(`Unknown attribute '${attr}=${node.$[attr]}' in '${nodeName}'`);
            }
          }
        }
      };

      const warnUnknownChildren = function(nodeName, node, knownChildren) {
        for (const child in node) {
          if (child !== '$' && !knownChildren.includes(child)) {
            out.warnings[fixKey].push(`Unknown child '${child}' in '${nodeName}'`);
          }
        }
      };

      const sortCapabilities = function(a, b) {
        return a.range[0] - b.range[0];
      };

      const addChannelToMode = function(key, dmxchannel, channel) {
        const existingChannels = fix.modes[0].channels;
        const existingChannelKey = existingChannels[dmxchannel];

        // check if there already is a channel for this DMX channel index
        if (existingChannelKey !== undefined &&
            existingChannelKey !== null) {
          const existingChannel = fix.availableChannels[existingChannelKey];

          // do both channels' capabilities overlap?
          let overlap = false;
          if (!('capabilities' in channel)) {
            channel.capabilities = [];
          }
          if (!('capabilities' in existingChannel)) {
            existingChannel.capabilities = [];
          }
          checkOverlap: for (const capability of channel.capabilities) {
            for (const existingCapability of existingChannel.capabilities) {
              if ((capability.range[0] <= existingCapability.range[0] &&
                   capability.range[1] >= existingCapability.range[0]) ||
                  (capability.range[0] <= existingCapability.range[1] &&
                   capability.range[1] >= existingCapability.range[1])) {
                overlap = true;
                break checkOverlap;
              }
            }
          }

          if (overlap) {
            out.warnings[fixKey].push(`Channels '${existingChannelKey}' and '${key}' have same DMX channel ${dmxchannel} and can't be merged because their capabilities overlap.`);
            fix.availableChannels[key] = channel;
          }
          else {
            existingChannel.capabilities = existingChannel.capabilities.concat(channel.capabilities).sort(sortCapabilities);
            out.warnings[fixKey].push(`Merged '${key}'´s capabilities into '${existingChannelKey}' as they have the same DMX channel ${dmxchannel}. Please check if ${existingChannel.type} is the correct type of the combined channel. Type of '${key}' was ${channel.type}.`);
          }
        }
        else {
          fix.availableChannels[key] = channel;
          existingChannels[dmxchannel] = key;
        }
      };

      const addPossibleFineChannel = function(singleFunction, normalChannelKey) {
        if ('finedmxchannel' in singleFunction.$) {
          const normalChannel = fix.availableChannels[normalChannelKey];
          let fineChannel = {
            type: normalChannel.type
          };
          if ('color' in normalChannel) {
            fineChannel.color = normalChannel.color;
          }

          const fineChannelKey = normalChannelKey + ' fine';
          addChannelToMode(fineChannelKey, singleFunction.$.finedmxchannel, fineChannel);

          if (fix.multiByteChannels === undefined) {
            fix.multiByteChannels = [];
          }
          fix.multiByteChannels.push([normalChannelKey, fineChannelKey]);
        }
      };

      // node can be step or range
      const getCapability = function(node, functionType) {
        if (typeof node === 'object' && '$' in node) {
          let capability = {
            range: [0, 255],
            name: 'Generic'
          };

          if ('range' in node && '$' in node.range[0]) {
            node.$ = Object.assign({}, node.$, node.range[0].$);
          }

          capability.range[0] = parseInt(node.$.mindmx);
          capability.range[1] = parseInt(node.$.maxdmx);

          let minval = 'minval' in node.$ ? node.$.minval : '?';
          let maxval = 'maxval' in node.$ ? node.$.maxval : '?';
          // range="X" can be a shorthand for 0-X
          if ('range' in node.$) {
            if (minval === '?') {
              minval = 0;
            }
            if (maxval === '?') {
              maxval = node.$.range;
            }
          }

          if (capability.range[0] > capability.range[1]) {
            // swap min/max
            capability.range = [capability.range[1], capability.range[0]];
            [minval, maxval] = [maxval, minval];
          }

          let valUsed = false;
          if ('type' in node.$ && 'val' in node.$) {
            if (node.$.type === 'color') {
              capability.color = node.$.val.toLowerCase();
              valUsed = true;
            }
            else if (node.$.type === 'image') {
              capability.image = node.$.val;
              valUsed = true;
            }
          }

          /// Naming
          let rangeString = '';
          if (minval !== '?' || maxval !== '?') {
            if (minval === maxval) {
              // not a real range
              rangeString = `${minval}`;
            }
            else {
              rangeString = `${minval}–${maxval}`;
            }
          }
          else if ('val' in node.$ && !valUsed) {
            rangeString = node.$.val;

            if (rangeString === 'true') {
              rangeString = 'On';
            }
            else if (rangeString === 'false') {
              rangeString = 'Off';
            }
          }

          if ('caption' in node.$) {
            capability.name = node.$.caption;

            if (rangeString.length > 0) {
              capability.name += ` ${rangeString}`;
            }

            if ('type' in node.$ && !valUsed) {
              capability.name += ` (${node.$.type})`;
            }
          }
          else if (rangeString.length > 0) {
            capability.name = rangeString;

            if ('type' in node.$ && !valUsed) {
              capability.name += ` (${node.$.type})`;
            }
          }
          else if ('type' in node.$ && !valUsed) {
            capability.name = node.$.type;
          }

          // physical information about panMax or tiltMax
          if (maxval !== '?' && (functionType === 'pan' || functionType === 'tilt')) {
            if (!('physical' in fix)) {
              fix.physical = {};
            }
            if (!('focus' in fix.physical)) {
              fix.physical.focus = {};
            }
            if (functionType + 'Max' in fix.physical.focus) {
              fix.physical.focus[functionType + 'Max'] = Math.max(
                fix.physical.focus[functionType + 'Max'],
                parseInt(maxval)
              );
            }
            else {
              fix.physical.focus[functionType + 'Max'] = parseInt(maxval);
            }
          }

          warnUnknownAttributes('range/step', node, ['type', 'mindmx', 'maxdmx', 'minval', 'maxval', 'val', 'range', 'caption', 'handler']);
          warnUnknownChildren('range/step', node, ['range']);

          if (isFinite(capability.range[0]) && isFinite(capability.range[1])) {
            return capability;
          }
        }
        return null;
      };

      const getCapabilities = function(node, functionType, caption) {
        let capabilities = [];
        let capabilityNodes = [];
        if ('range' in node) {
          capabilityNodes = capabilityNodes.concat(node.range);
        }
        if ('step' in node) {
          capabilityNodes = capabilityNodes.concat(node.step);
        }

        for (const node of capabilityNodes) {
          if (caption !== undefined) {
            node.$.caption = caption;
          }
          const cap = getCapability(node, functionType);
          if (cap !== null) {
            capabilities.push(cap);
          }
        }

        if ('$' in node && 'mindmx' in node.$ && 'maxdmx' in node.$) {
          capabilities.push({
            range: [
              parseInt(node.$.mindmx),
              parseInt(node.$.maxdmx)
            ],
            name: 'Generic'
          });
        }

        return capabilities;
      };

      const getUniqueChannelKey = function(key) {
        if (!(key in fix.availableChannels)) {
          return key;
        }
        let i = 2;
        while (`${key} ${i}` in fix.availableChannels) {
          i++;
        }
        return `${key} ${i}`;
      };

      const parseSimpleFunction = function(functionType, functionContainer, functionIndex) {
        const singleFunction = functionContainer[functionType][functionIndex];
        const caps = getCapabilities(singleFunction, functionType);

        if ('$' in singleFunction && 'dmxchannel' in singleFunction.$) {
          let channel = {};

          let channelKey;
          if ('name' in singleFunction.$) {
            channelKey = singleFunction.$.name;
          }
          else {
            switch (functionType) {
              case 'strobo':
                channelKey = 'Strobe';
                break;

              case 'ptspeed':
                channelKey = 'Pan/Tilt Speed';
                break;

              default:
                channelKey = capitalize(functionType);
            }

            // "Dimmer" if there's only one dimmer
            // "Dimmer 1", "Dimmer 2", ... if there are more dimmers
            if (functionContainer[functionType].length > 1) {
              channelKey += ` ${functionIndex+1}`;
            }
          }

          // append " 2", " 3", ... to channel key if it isn't unique
          channelKey = getUniqueChannelKey(channelKey);

          if (['pan', 'shutter', 'strobe', 'tilt'].includes(functionType)) {
            channel.type = capitalize(functionType);
          }
          else {
            const channelTypes = {
              Beam: ['focus', 'iris', 'zoom'],
              Intensity: ['colortemp', 'dimmer', 'fog', 'frost'],
              MultiColor: ['colorwheel'],
              Speed: ['bladebottom', 'bladeleft', 'bladeright', 'bladetop', 'fan', 'ptspeed', 'rotation'],
              Strobe: ['strobo']
            };
            let typeFound = false;
            for (const type in channelTypes) {
              typeFound = channelTypes[type].includes(functionType);
              if (typeFound) {
                channel.type = type;
                break;
              }
            }

            if (!typeFound) {
              if ('name' in singleFunction.$) {
                // maybe channel name gives us more information
                // about channel type than the function type does
                const testName = singleFunction.$.name.toLowerCase();
                if (testName.includes('intensity')) {
                  channel.type = 'Intensity';
                }
                else if (testName.includes('speed') || testName.includes('duration')) {
                  channel.type = 'Speed';
                }
                else {
                  channel.type = 'Intensity';
                  out.warnings[fixKey].push(`Please check channel type of '${channelKey}'`);
                }
              }
              else {
                channel.type = 'Intensity';
                out.warnings[fixKey].push(`Please check channel type of '${channelKey}'`);
              }
            }
          }

          channel.capabilities = caps;

          if ('defaultval' in singleFunction.$) {
            channel.defaultValue = parseInt(singleFunction.$.defaultval);
          }
          else if ('val' in singleFunction.$) {
            channel.defaultValue = parseInt(singleFunction.$.val);
          }

          if (functionType === 'const') {
            channel.constant = true;
          }

          const subFunctions = {
            rainbow: 'Rainbow',
            random: 'Random',
            wheelrotation: 'Rotation'
          };
          for (const subFunction in subFunctions) {
            if (subFunction in singleFunction) {
              for (const singleSubFunction of singleFunction[subFunction]) {
                const caps = getCapabilities(singleSubFunction, subFunction, subFunctions[subFunction]);
                channel.capabilities = channel.capabilities.concat(caps);
              }
            }
          }

          channel.capabilities.sort(sortCapabilities);
          if (channel.capabilities.length === 0) {
            delete channel.capabilities;
          }

          addChannelToMode(channelKey, singleFunction.$.dmxchannel, channel);
          addPossibleFineChannel(singleFunction, channelKey);

          warnUnknownAttributes(functionType, singleFunction, ['name', 'defaultval', 'val', 'constant', 'dmxchannel', 'mindmx', 'maxdmx', 'finedmxchannel']);
        }

        if ('raw' in singleFunction) {
          for (let i = 0; i < singleFunction.raw.length; i++) {
            parseSimpleFunction('raw', singleFunction, i);
          }
        }

        warnUnknownChildren(functionType, singleFunction, ['range', 'step', 'raw', 'focus']);
      };

      const parseColorFunctionCompound = function(colorFunctionCompoundType, colorFunctionCompound, x, y) {
        for (const singleColorFunctionType in colorFunctionCompound) {
          let color = singleColorFunctionType.toLowerCase();

          switch (color) {
            case 'r':
              color = 'Red';
              break;

            case 'g':
              color = 'Green';
              break;

            case 'b':
              color = 'Blue';
              break;

            case 'c':
              color = 'Cyan';
              break;

            case 'm':
              color = 'Magenta';
              break;

            case 'y':
              color = 'Yellow';
              break;

            case 'w':
              color = 'White';
              break;

            case 'uv':
              color = 'UV';
              break;

            default:
              color = capitalize(color);
          }

          const singleColorFunction = colorFunctionCompound[singleColorFunctionType][0];

          let channel = {
            type: 'SingleColor',
            color: color
          };

          let position;
          if (x !== undefined && y !== undefined) {
            position = `(${x+1}|${y+1})`;
          }

          let channelKey = color;
          if (position !== undefined) {
            channelKey += ` ${position}`;
          }
          channelKey = getUniqueChannelKey(channelKey);
          fix.availableChannels[channelKey] = channel;

          if (position !== undefined) {
            if (!('heads' in fix)) {
              fix.heads = {};
            }
            if (!(position in fix.heads)) {
              fix.heads[position] = [];
            }
            fix.heads[position].push(channelKey);
          }

          addChannelToMode(channelKey, singleColorFunction.$.dmxchannel, channel);
          addPossibleFineChannel(singleColorFunction, channelKey);

          warnUnknownAttributes(singleColorFunctionType, singleColorFunction, ['dmxchannel', 'finedmxchannel']);
          warnUnknownChildren(singleColorFunctionType, singleColorFunction, ['']);
        }

        warnUnknownAttributes(colorFunctionCompoundType, colorFunctionCompound, []);
      };

      const functions = device.functions[0];
      for (const functionType in functions) {
        for (let i = 0; i < functions[functionType].length; i++) {
          const singleFunction = functions[functionType][i];

          switch (functionType) {
            case 'colortemp':
            case 'colorwheel':
            case 'const':
            case 'dimmer':
            case 'fan':
            case 'focus':
            case 'fog':
            case 'frost':
            case 'iris':
            case 'ptspeed':
            case 'raw':
            case 'rawstep':
            case 'rotation':
            case 'strobe':
            case 'strobo':
            case 'shutter':
            case 'switch':
            case 'zoom':
              parseSimpleFunction(functionType, functions, i);
              break;

            case 'rgb':
            case 'cmy':
              parseColorFunctionCompound(functionType, singleFunction);
              break;

            case 'hsv':
              warnUnknownAttributes(functionType, singleFunction, []);

              for (const hsvFunctionType in singleFunction) {
                let hsvType = hsvFunctionType.toLowerCase();

                switch (hsvType) {
                  case 'h':
                    hsvType = 'Hue';
                    break;

                  case 's':
                    hsvType = 'Saturation';
                    break;

                  case 'v':
                  case 'value':
                    hsvType = 'HSV Value';
                    break;

                  default:
                    hsvType = capitalize(hsvType);
                }

                const hsvFunction = singleFunction[hsvFunctionType][0];

                let channel = {
                  type: 'Intensity'
                };

                const channelKey = getUniqueChannelKey(hsvType);
                fix.availableChannels[channelKey] = channel;

                addChannelToMode(channelKey, hsvFunction.$.dmxchannel, channel);
                addPossibleFineChannel(hsvFunction, channelKey);

                warnUnknownAttributes(hsvFunctionType, hsvFunction, ['dmxchannel', 'finedmxchannel']);
                warnUnknownChildren(hsvFunctionType, hsvFunction, ['']);
              }

              break;

            case 'matrix':
              const rows = singleFunction.$.rows;
              const columns = singleFunction.$.columns;
              const monochrome = singleFunction.$.monochrome === 'true';
              const dmxchannel = 'dmxchannel' in singleFunction.$ ? parseInt(singleFunction.$.dmxchannel) : -1;

              warnUnknownAttributes(functionType, singleFunction, ['rows', 'columns', 'monochrome', 'dmxchannel']);

              if (dmxchannel < 0) {
                warnUnknownChildren(functionType, singleFunction, ['rgb']);
              }
              else {
                warnUnknownChildren(functionType, singleFunction, []);
              }

              for (let y = 0; y < rows; y++) {
                for (let x = 0; x < columns; x++) {
                  let colorFunctionCompound;
                  if (dmxchannel < 0) {
                    colorFunctionCompound = singleFunction.rgb[y*columns+x];
                  }
                  else if (monochrome) {
                    colorFunctionCompound = {
                      white: [{
                        $: {
                          dmxchannel: dmxchannel + y*columns+x
                        }
                      }]
                    };
                  }
                  else {
                    colorFunctionCompound = {
                      red: [{
                        $: {
                          dmxchannel: dmxchannel + 3*(y*columns+x)
                        }
                      }],
                      green: [{
                        $: {
                          dmxchannel: dmxchannel + 3*(y*columns+x) + 1
                        }
                      }],
                      blue: [{
                        $: {
                          dmxchannel: dmxchannel + 3*(y*columns+x) + 2
                        }
                      }]
                    };
                  }

                  parseColorFunctionCompound('rgb', colorFunctionCompound, x, y);
                }
              }

              break;

            case 'position':
              if ('pan' in singleFunction) {
                parseSimpleFunction('pan', singleFunction, 0);
              }
              if ('tilt' in singleFunction) {
                parseSimpleFunction('tilt', singleFunction, 0);
              }

              warnUnknownAttributes(functionType, singleFunction, []);
              warnUnknownChildren(functionType, singleFunction, ['pan', 'tilt']);

              break;

            case 'blades':
              const children = ['bladetop', 'bladeright', 'bladebottom', 'bladeleft'];
              for (const child of children) {
                for (let n = 0; n < singleFunction[child].length; n++) {
                  parseSimpleFunction(child, singleFunction, n);
                }
              }

              warnUnknownChildren(functionType, singleFunction, children);

              break;

            default:
              out.warnings[fixKey].push(`Unknown function type ${functionType}`);
          }
        }
      }

      for (let i = 0; i < fix.modes[0].channels.length; i++) {
        if (fix.modes[0].channels[i] === undefined) {
          fix.modes[0].channels[i] = null;
        }
      }

      if (fix.categories.length === 0) {
        fix.categories.push('Other');
      }

      out.fixtures[fixKey] = fix;

      return resolve(out);
    }
    catch (parseError) {
      return reject(`Error parsing '${filename}'.\n` + parseError.toString());
    }
  });
};