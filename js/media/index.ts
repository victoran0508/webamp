/* Emulate the native <audio> element with Web Audio API */
import { BANDS, MEDIA_STATUS } from "../constants";
import Emitter from "../emitter";
import ElementSource from "./elementSource";
import { Band } from "../types";
// import detectChannels from "./detectChannels";

export default class Media {
  _emitter: Emitter;
  _context: AudioContext;
  _channels: number | null;
  _balance: number;
  _staticSource: AnalyserNode;
  _preamp: GainNode;
  _chanSplit: ChannelSplitterNode;
  _leftGain: GainNode;
  _rightGain: GainNode;
  _chanMerge: ChannelMergerNode;
  _analyser: AnalyserNode;
  _gainNode: GainNode;
  _source: ElementSource;
  _bands: { [band: number]: BiquadFilterNode };

  constructor() {
    this._emitter = new Emitter();
    // @ts-ignore Typescript does not know about webkitAudioContext
    this._context = new (window.AudioContext || window.webkitAudioContext)();
    // Fix for iOS and Chrome (Canary) which require that the context be created
    // or resumed by a user interaction.
    // https://developers.google.com/web/updates/2017/09/autoplay-policy-changes
    // https://gist.github.com/laziel/7aefabe99ee57b16081c
    // Via: https://stackoverflow.com/a/43395068/1263117
    if (this._context.state === "suspended") {
      const resume = async () => {
        await this._context.resume();

        if (this._context.state === "running") {
          // TODO: Add this to the disposable
          document.body.removeEventListener("touchend", resume, false);
          document.body.removeEventListener("click", resume, false);
          document.body.removeEventListener("keydown", resume, false);
        }
      };

      document.body.addEventListener("touchend", resume, false);
      document.body.addEventListener("click", resume, false);
      document.body.addEventListener("keydown", resume, false);
    }
    // We don't currently know how many channels
    this._channels = null;
    this._balance = 0;

    // The _source node has to be recreated each time it's stopped or
    // paused, so we don't create it here. Instead we create this dummy
    // node wich the real source will connect to.

    // TODO: Maybe we can get rid of this now that we are using AudioAbstraction?
    this._staticSource = this._context.createAnalyser(); // Just a noop node

    // Create the preamp node
    this._preamp = this._context.createGain();

    // Create the spliter node
    this._chanSplit = this._context.createChannelSplitter(2);

    // Create the gains for left and right
    this._leftGain = this._context.createGain();
    this._rightGain = this._context.createGain();

    // Create channel merge
    this._chanMerge = this._context.createChannelMerger(2);

    // Create the analyser node for the visualizer
    this._analyser = this._context.createAnalyser();
    this._analyser.fftSize = 2048;
    // don't smooth audio analysis
    this._analyser.smoothingTimeConstant = 0.0;

    // Create the gain node for the volume control
    this._gainNode = this._context.createGain();

    // Connect all the nodes in the correct way
    // (Note, source is created and connected later)
    //
    //                <source>
    //                    |
    //                    |_____________
    //                    |             \
    //                <preamp>          |
    //                    |             | <-- Optional bypass
    //           [...biquadFilters]     |
    //                    |_____________/
    //                    |
    //    (split using createChannelSplitter)
    //                    |
    //                   / \
    //                  /   \
    //          <leftGain><rightGain>
    //                  \   /
    //                   \ /
    //                    |
    //     (merge using createChannelMerger)
    //                    |
    //               <chanMerge>
    //                    |
    //                    |\
    //                    | <analyser>
    //                  <gain>
    //                    |
    //              <destination>

    this._source = new ElementSource(this._context, this._staticSource);

    this._source.on("positionChange", () => {
      this._emitter.trigger("timeupdate");
    });
    this._source.on("ended", () => {
      this._emitter.trigger("ended");
    });
    this._source.on("statusChange", () => {
      switch (this._source.getStatus()) {
        case MEDIA_STATUS.PLAYING:
          this._emitter.trigger("playing");
          break;
      }
      this._emitter.trigger("timeupdate");
    });
    this._source.on("loaded", () => {
      this._emitter.trigger("fileLoaded");
    });

    this._staticSource.connect(this._preamp);

    let output = this._preamp;
    this._bands = {};

    BANDS.forEach((band, i) => {
      const filter = this._context.createBiquadFilter();

      this._bands[band] = filter;

      if (i === 0) {
        // The first filter, includes all lower frequencies
        filter.type = "lowshelf";
      } else if (i === BANDS.length - 1) {
        // The last filter, includes all higher frequencies
        filter.type = "highshelf";
      } else {
        filter.type = "peaking";
      }
      filter.frequency.value = band;
      filter.gain.value = 0;

      output.connect(filter);
      output = filter;
    });

    output.connect(this._chanSplit);

    // Connect split channels to left / right gains
    this._chanSplit.connect(
      this._leftGain,
      0
    );
    this._chanSplit.connect(
      this._rightGain,
      1
    );

    // Reconnect the left / right gains to the merge node
    this._leftGain.connect(
      this._chanMerge,
      0,
      0
    );
    this._rightGain.connect(
      this._chanMerge,
      0,
      1
    );

    this._chanMerge.connect(this._gainNode);
    this._chanMerge.connect(this._analyser);

    this._gainNode.connect(this._context.destination);
  }

  _setChannels(num: number | null) {
    const assumedChannels = num == null ? 2 : num;
    this._chanSplit.disconnect();
    this._chanSplit.connect(
      this._leftGain,
      0
    );
    // If we only have one channel, use it for both left and right.
    this._chanSplit.connect(
      this._rightGain,
      assumedChannels === 1 ? 0 : 1
    );
    this._channels = num;
    this._emitter.trigger("channelupdate");
  }

  getAnalyser() {
    return this._analyser;
  }

  /* Properties */
  duration() {
    return this._source.getDuration();
  }

  timeElapsed() {
    return this._source.getTimeElapsed();
  }

  timeRemaining() {
    return this.duration() - this.timeElapsed();
  }

  percentComplete() {
    return (this.timeElapsed() / this.duration()) * 100;
  }

  channels() {
    return this._channels == null ? 2 : this._channels;
  }

  sampleRate() {
    return this._source.getSampleRate();
  }

  /* Actions */
  async play() {
    await this._source.play();
    if (this._channels == null) {
      // Temporarily disabled https://github.com/captbaritone/webamp/issues/551
      /*
      detectChannels(this._staticSource)
        .then(channels => {
          this._setChannels(channels);
        })
        .catch(() => {
          this._setChannels(null);
        });
      */
    }
  }

  pause() {
    this._source.pause();
  }

  stop() {
    this._source.stop();
  }

  /* Actions with arguments */
  seekToPercentComplete(percent: number) {
    const seekTime = this.duration() * (percent / 100);
    this.seekToTime(seekTime);
  }

  // From 0-1
  setVolume(volume: number) {
    this._gainNode.gain.value = volume / 100;
  }

  // From 0-1
  setPreamp(value: number) {
    this._preamp.gain.value = value / 100;
  }

  // From -100 to 100
  setBalance(balance: number) {
    let changeVal = Math.abs(balance) / 100;

    // Hack for Firefox. Having either channel set to 0 seems to revert us
    // to equal balance.
    changeVal = changeVal - 0.00000001;

    if (balance > 0) {
      // Right
      this._leftGain.gain.value = 1 - changeVal;
      this._rightGain.gain.value = 1;
    } else if (balance < 0) {
      // Left
      this._leftGain.gain.value = 1;
      this._rightGain.gain.value = 1 - changeVal;
    } else {
      // Center
      this._leftGain.gain.value = 1;
      this._rightGain.gain.value = 1;
    }
    this._balance = balance;
  }

  setEqBand(band: Band, value: number) {
    const db = (value / 100) * 24 - 12;
    this._bands[band].gain.value = db;
  }

  disableEq() {
    this._staticSource.disconnect();
    this._staticSource.connect(this._chanSplit);
  }

  enableEq() {
    this._staticSource.disconnect();
    this._staticSource.connect(this._preamp);
  }

  /* Listeners */
  on(event: string, callback: (...args: any[]) => void) {
    this._emitter.on(event, callback);
  }

  seekToTime(time: number) {
    this._source.seekToTime(time);
  }

  // Used only for the initial load, since it must have a CORS header
  async loadFromUrl(url: string, autoPlay: boolean) {
    this._emitter.trigger("waiting");
    await this._source.loadUrl(url);
    this._setChannels(null);
    this._emitter.trigger("stopWaiting");
    if (autoPlay) {
      this.play();
    }
  }

  dispose() {
    this._source.dispose();
    this._emitter.dispose();
  }
}
