module.exports = {
  name: 'Fixture name', // required
  categories: ['Other'], // required
  meta: {
    authors: [],
    createDate: '1970-01-01',
    lastModifyDate: '1970-01-01'
  },
  physical: {
    dimensions: [0, 0, 0],
    weight: 0,
    power: 0,
    DMXconnector: '3-pin',
    bulb: {
      type: 'Other',
      colorTemperature: 0,
      lumens: 0
    },
    lens: {
      name: 'Other',
      degreesMinMax: [0, 0]
    },
    focus: {
      type: 'Fixed',
      panMax: 0,
      tiltMax: 0
    }
  },
  availableChannels: { // required
    'channel key': {
      type: 'Intensity', // required
      defaultValue: 0,
      highlightValue: 0,
      invert: false,
      constant: false,
      crossfade: false,
      precedence: 'LTP',
      capabilities: [
        {
          range: [0, 255], // required
          name: '0-100%', // required
          menuClick: 'start'
        }
      ]
    }
  },
  modes: [ // required
    {
      name: '1-channel', // required
      channels: ['channel key'] // required
    }
  ]
};
