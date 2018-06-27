/*

	This file is part of OpenWebRX,
	an open-source SDR receiver software with a web UI.
	Copyright (c) 2013-2015 by Andras Retzler <randras@sdr.hu>

    This program is free software: you can redistribute it and/or modify
    it under the terms of the GNU Affero General Public License as
    published by the Free Software Foundation, either version 3 of the
    License, or (at your option) any later version.

    This program is distributed in the hope that it will be useful,
    but WITHOUT ANY WARRANTY; without even the implied warranty of
    MERCHANTABILITY or FITNESS FOR A PARTICULAR PURPOSE.  See the
    GNU Affero General Public License for more details.

    You should have received a copy of the GNU Affero General Public License
    along with this program.  If not, see <http://www.gnu.org/licenses/>.

"""

*/

is_firefox=navigator.userAgent.indexOf("Firefox")!=-1;

function arrayBufferToString(buf) {
	//http://stackoverflow.com/questions/6965107/converting-between-strings-and-arraybuffers
	return String.fromCharCode.apply(null, new Uint8Array(buf));
}

function getFirstChars(buf, num)
{
	var u8buf=new Uint8Array(buf);
	var output=String();
	num=Math.min(num,u8buf.length);
	for(i=0;i<num;i++) output+=String.fromCharCode(u8buf[i]);
	return output;
}

var bandwidth;
var center_freq;
var audio_buffer_current_size_debug=0;
var audio_buffer_all_size_debug=0;
var audio_buffer_current_count_debug=0;
var audio_buffer_current_size=0;
var fft_size;
var fft_fps;
var fft_compression="none";
var fft_codec=new sdrjs.ImaAdpcm();
var audio_compression="none";
var waterfall_setup_done=0;
var waterfall_queue = [];
var waterfall_timer;
var secondary_fft_size;

var rx_photo_state=1;

function e(what) { return document.getElementById(what); }

ios = /iPad|iPod|iPhone|Chrome/.test(navigator.userAgent);
is_chrome = /Chrome/.test(navigator.userAgent);

dont_toggle_rx_photo_flag=0;

function dont_toggle_rx_photo()
{
	dont_toggle_rx_photo_flag=1;
}

function toggle_rx_photo()
{
	if(dont_toggle_rx_photo_flag) { dont_toggle_rx_photo_flag=0; return; }
	if(rx_photo_state) close_rx_photo();
	else open_rx_photo()
}

function updateVolume(n)
{
	volume = n / 100;
}

// ========================================================
// ================  DEMODULATOR ROUTINES  ================
// ========================================================

demodulators=[]

demodulator_color_index=0;
demodulator_colors=["#ffff00", "#00ff00", "#00ffff", "#058cff", "#ff9600", "#a1ff39", "#ff4e39", "#ff5dbd"]
function demodulators_get_next_color()
{
	if(demodulator_color_index>=demodulator_colors.length) demodulator_color_index=0;
	return(demodulator_colors[demodulator_color_index++]);
}

function demod_envelope_where_clicked(x, drag_ranges, key_modifiers)
{  // Check exactly what the user has clicked based on ranges returned by demod_envelope_draw().
	in_range=function(x,range) { return range.x1<=x&&range.x2>=x; }
	dr=demodulator.draggable_ranges;

	if(key_modifiers.shiftKey)
	{
		//Check first: shift + center drag emulates BFO knob
		if(drag_ranges.line_on_screen&&in_range(x,drag_ranges.line)) return dr.bfo;
		//Check second: shift + envelope drag emulates PBF knob
		if(drag_ranges.envelope_on_screen&&in_range(x,drag_ranges.whole_envelope)) return dr.pbs;
	}
	if(drag_ranges.envelope_on_screen)
	{
		// For low and high cut:
		if(in_range(x,drag_ranges.beginning)) return dr.beginning;
		if(in_range(x,drag_ranges.ending)) return dr.ending;
		// Last priority: having clicked anything else on the envelope, without holding the shift key
		if(in_range(x,drag_ranges.whole_envelope)) return dr.anything_else;
	}
	return dr.none; //User doesn't drag the envelope for this demodulator
}

//******* class demodulator *******
// this can be used as a base class for ANY demodulator
demodulator=function(offset_frequency)
{
	//console.log("this too");
	this.offset_frequency=offset_frequency;
	this.has_audio_output=true;
	this.has_text_output=false;
	this.envelope={};
	this.color=demodulators_get_next_color();
	this.stop=function(){};
}
//ranges on filter envelope that can be dragged:
demodulator.draggable_ranges={none: 0, beginning:1 /*from*/, ending: 2 /*to*/, anything_else: 3, bfo: 4 /*line (while holding shift)*/, pbs: 5 } //to which parameter these correspond in demod_envelope_draw()

//******* class demodulator_default_analog *******
// This can be used as a base for basic audio demodulators.
// It already supports most basic modulations used for ham radio and commercial services: AM/FM/LSB/USB

demodulator_response_time=50;
//in ms; if we don't limit the number of SETs sent to the server, audio will underrun (possibly output buffer is cleared on SETs in GNU Radio

function demodulator_default_analog(offset_frequency,subtype)
{
	//console.log("hopefully this happens");
	//http://stackoverflow.com/questions/4152931/javascript-inheritance-call-super-constructor-or-use-prototype-chain
	demodulator.call(this,offset_frequency);
	this.subtype=subtype;
	this.filter={
		min_passband: 100,
		high_cut_limit: (audio_server_output_rate/2)-1, //audio_context.sampleRate/2,
		low_cut_limit: (-audio_server_output_rate/2)+1 //-audio_context.sampleRate/2
	};
	//Subtypes only define some filter parameters and the mod string sent to server,
	//so you may set these parameters in your custom child class.
	//Why? As of demodulation is done on the server, difference is mainly on the server side.
	this.server_mod=subtype;
	if(subtype=="lsb")
	{
		this.low_cut=-3000;
		this.high_cut=-300;
		this.server_mod="ssb";
	}
	else if(subtype=="usb")
	{
		this.low_cut=300;
		this.high_cut=3000;
		this.server_mod="ssb";
	}
	else if(subtype=="cw")
	{
		this.low_cut=700;
		this.high_cut=900;
		this.server_mod="ssb";
	}
	else if(subtype=="nfm")
	{
		this.low_cut=-4000;
		this.high_cut=4000;
	}
	else if(subtype=="am")
	{
		this.low_cut=-4000;
		this.high_cut=4000;
	}

	this.wait_for_timer=false;
	this.set_after=false;
	this.set=function()
	{ //set() is a wrapper to call doset(), but it ensures that doset won't execute more frequently than demodulator_response_time.
		if(!this.wait_for_timer)
		{
			this.doset(false);
			this.set_after=false;
			this.wait_for_timer=true;
			timeout_this=this; //http://stackoverflow.com/a/2130411
			window.setTimeout(function() {
				timeout_this.wait_for_timer=false;
				if(timeout_this.set_after) timeout_this.set();
			},demodulator_response_time);
		}
		else
		{
			this.set_after=true;
		}
	}

	this.doset=function(first_time)
	{  //this function sends demodulator parameters to the server
		ws.send("SET"+((first_time)?" mod="+this.server_mod:"")+
			" low_cut="+this.low_cut.toString()+" high_cut="+this.high_cut.toString()+
			" offset_freq="+this.offset_frequency.toString());
	}
	this.doset(true); //we set parameters on object creation

	//******* envelope object *******
   // for drawing the filter envelope above scale
	this.envelope.parent=this;

	this.envelope.draw=function(visible_range)
	{
		this.visible_range=visible_range;
		this.drag_ranges=demod_envelope_draw(range,
				center_freq+this.parent.offset_frequency+this.parent.low_cut,
				center_freq+this.parent.offset_frequency+this.parent.high_cut,
				this.color,center_freq+this.parent.offset_frequency);
	};

	// event handlers
	this.envelope.drag_start=function(x, key_modifiers)
	{
		this.key_modifiers=key_modifiers;
		this.dragged_range=demod_envelope_where_clicked(x,this.drag_ranges, key_modifiers);
		//console.log("dragged_range: "+this.dragged_range.toString());
		this.drag_origin={
			x: x,
			low_cut: this.parent.low_cut,
			high_cut: this.parent.high_cut,
			offset_frequency: this.parent.offset_frequency
		};
		return this.dragged_range!=demodulator.draggable_ranges.none;
	};

	this.envelope.drag_move=function(x)
	{
		dr=demodulator.draggable_ranges;
		if(this.dragged_range==dr.none) return false; // we return if user is not dragging (us) at all
		freq_change=Math.round(this.visible_range.hps*(x-this.drag_origin.x));
		/*if(this.dragged_range==dr.beginning||this.dragged_range==dr.ending)
		{
			//we don't let the passband be too small
			if(this.parent.low_cut+new_freq_change<=this.parent.high_cut-this.parent.filter.min_passband) this.freq_change=new_freq_change;
			else return;
		}
		var new_value;*/

		//dragging the line in the middle of the filter envelope while holding Shift does emulate
		//the BFO knob on radio equipment: moving offset frequency, while passband remains unchanged
		//Filter passband moves in the opposite direction than dragged, hence the minus below.
		minus=(this.dragged_range==dr.bfo)?-1:1;
		//dragging any other parts of the filter envelope while holding Shift does emulate the PBS knob
		//(PassBand Shift) on radio equipment: PBS does move the whole passband without moving the offset
		//frequency.
		if(this.dragged_range==dr.beginning||this.dragged_range==dr.bfo||this.dragged_range==dr.pbs)
		{
			//we don't let low_cut go beyond its limits
			if((new_value=this.drag_origin.low_cut+minus*freq_change)<this.parent.filter.low_cut_limit) return true;
			//nor the filter passband be too small
			if(this.parent.high_cut-new_value<this.parent.filter.min_passband) return true;
			//sanity check to prevent GNU Radio "firdes check failed: fa <= fb"
			if(new_value>=this.parent.high_cut) return true;
			this.parent.low_cut=new_value;
		}
		if(this.dragged_range==dr.ending||this.dragged_range==dr.bfo||this.dragged_range==dr.pbs)
		{
			//we don't let high_cut go beyond its limits
			if((new_value=this.drag_origin.high_cut+minus*freq_change)>this.parent.filter.high_cut_limit) return true;
			//nor the filter passband be too small
			if(new_value-this.parent.low_cut<this.parent.filter.min_passband) return true;
			//sanity check to prevent GNU Radio "firdes check failed: fa <= fb"
			if(new_value<=this.parent.low_cut) return true;
			this.parent.high_cut=new_value;
		}
		if(this.dragged_range==dr.anything_else||this.dragged_range==dr.bfo)
		{
			//when any other part of the envelope is dragged, the offset frequency is changed (whole passband also moves with it)
			new_value=this.drag_origin.offset_frequency+freq_change;
			if(new_value>bandwidth/2||new_value<-bandwidth/2) return true; //we don't allow tuning above Nyquist frequency :-)
			this.parent.offset_frequency=new_value;
		}
		//now do the actual modifications:
		// mkenvelopes(this.visible_range);
		this.parent.set();
		//will have to change this when changing to multi-demodulator mode:
		e("webrx-actual-freq").innerHTML=format_frequency("{x} MHz",center_freq+this.parent.offset_frequency,1e6,4);
		return true;
	};

	this.envelope.drag_end=function(x)
	{ //in this demodulator we've already changed values in the drag_move() function so we shouldn't do too much here.
		to_return=this.dragged_range!=demodulator.draggable_ranges.none; //this part is required for cliking anywhere on the scale to set offset
		this.dragged_range=demodulator.draggable_ranges.none;
		return to_return;
	};

}

demodulator_default_analog.prototype=new demodulator();

function demodulator_remove(which)
{
	demodulators[which].stop();
	demodulators.splice(which,1);
}

function demodulator_add(what)
{
	demodulators.push(what);
}

last_analog_demodulator_subtype = 'nfm';
last_digital_demodulator_subtype = 'bpsk31';

function demodulator_analog_replace(subtype, for_digital)
{ //this function should only exist until the multi-demodulator capability is added
    if(!(typeof for_digital !== "undefined" && for_digital && secondary_demod)) 
    { 
        secondary_demod_close_window(); 
        secondary_demod_listbox_update(); 
    }
    last_analog_demodulator_subtype = subtype;
	var temp_offset=0;
	if(demodulators.length)
	{
		temp_offset=demodulators[0].offset_frequency;
		demodulator_remove(0);
	}
	demodulator_add(new demodulator_default_analog(temp_offset,subtype));
}

function demodulator_set_offset_frequency(which,to_what)
{
	if(to_what>bandwidth/2||to_what<-bandwidth/2) return;
	demodulators[0].offset_frequency=Math.round(to_what);
	demodulators[0].set();
	mkenvelopes(get_visible_freq_range());
}


// ========================================================
// ===================  SCALE ROUTINES  ===================
// ========================================================

function audio_calculate_resampling(targetRate)
{ //both at the server and the client
	output_range_max = 12000;
	output_range_min = 8000;
	i = 1;
	while(true)
	{
		audio_server_output_rate = Math.floor(targetRate / i);
		if(audio_server_output_rate < output_range_min)
		{
			audio_client_resampling_factor = audio_server_output_rate = 0;
			divlog("Your audio card sampling rate ("+targetRate.toString()+") is not supported.<br />Please change your operating system default settings in order to fix this.",1);
		}
		if(audio_server_output_rate >= output_range_min	&& audio_server_output_rate <= output_range_max) break; //okay, we're done
		i++;
	}
	audio_client_resampling_factor=i;
	console.log("audio_calculate_resampling() :: "+audio_client_resampling_factor.toString()+", "+audio_server_output_rate.toString());
}


debug_ws_data_received=0;
max_clients_num=0;

var COMPRESS_FFT_PAD_N=10; //should be the same as in csdr.c

function on_ws_recv(evt)
{
	if(!(evt.data instanceof ArrayBuffer)) { divlog("on_ws_recv(): Not ArrayBuffer received...",1); return; }
	//
	debug_ws_data_received+=evt.data.byteLength/1000;
	first4Chars=getFirstChars(evt.data,4);
	first3Chars=first4Chars.slice(0,3);
	if(first3Chars=="CLI")
	{
		var stringData=arrayBufferToString(evt.data);
		if(stringData.substring(0,16)=="CLIENT DE SERVER") divlog("Server acknowledged WebSocket connection.");

	}
	if(first3Chars=="SND")
	{
		var audio_data;
		if(audio_compression=="adpcm") audio_data=new Uint8Array(evt.data,4)
		else audio_data=new Int16Array(evt.data,4);
		audio_prepare(audio_data);
		audio_buffer_current_size_debug+=audio_data.length;
		audio_buffer_all_size_debug+=audio_data.length;
		if(!(ios||is_chrome) && (audio_initialized==0 && audio_prepared_buffers.length>audio_buffering_fill_to)) audio_init()
	}
	else if(first3Chars=="FFT")
	{
		//alert("Yupee! Doing FFT");
        //if(first4Chars=="FFTS") console.log("FFTS"); 
		if(fft_compression=="none") waterfall_add_queue(new Float32Array(evt.data,4));
		else if(fft_compression="adpcm")
		{
			fft_codec.reset();

			var waterfall_i16=fft_codec.decode(new Uint8Array(evt.data,4));
			var waterfall_f32=new Float32Array(waterfall_i16.length-COMPRESS_FFT_PAD_N);
			for(var i=0;i<waterfall_i16.length;i++) waterfall_f32[i]=waterfall_i16[i+COMPRESS_FFT_PAD_N]/100;
            if(first4Chars=="FFTS") secondary_demod_waterfall_add_queue(waterfall_f32); //TODO digimodes
            else waterfall_add_queue(waterfall_f32);
		}
	} 
    else if(first3Chars=="DAT")
    {
        //secondary_demod_push_binary_data(new Uint8Array(evt.data,4));
        secondary_demod_push_data(arrayBufferToString(evt.data).substring(4));
        //console.log("DAT");
	} 
    else if(first3Chars=="MSG")
	{
		/*try
		{*/
			var stringData=arrayBufferToString(evt.data);
			console.log(stringData);
			params=stringData.substring(4).split(" ");
			for(i=0;i<params.length;i++)
			{
				param=params[i].split("=");
				switch(param[0])
				{
					case "setup":
						waterfall_init();
						audio_preinit();
						break;
					case "bandwidth":
						bandwidth=parseInt(param[1]);
						break;
					case "center_freq":
						center_freq=parseInt(param[1]); //there was no ; and it was no problem... why?
						break;
					case "fft_size":
						fft_size=parseInt(param[1]);
						break;
					case "secondary_fft_size":
						secondary_fft_size=parseInt(param[1]);
						break;
                    case "secondary_setup":
                        secondary_demod_init_canvases();
                        break;
                    case "if_samp_rate":
                        if_samp_rate=parseInt(param[1]);
                        break;
                    case "secondary_bw":
                        secondary_bw=parseFloat(param[1]);
                        break;
					case "fft_fps":
						fft_fps=parseInt(param[1]);
						break;
					case "audio_compression":
						audio_compression=param[1];
						divlog( "Audio stream is "+ ((audio_compression=="adpcm")?"compressed":"uncompressed")+"." )
						break;
					case "fft_compression":
						fft_compression=param[1];
						divlog( "FFT stream is "+ ((fft_compression=="adpcm")?"compressed":"uncompressed")+"." )
						break;
					case "cpu_usage":
						var server_cpu_usage=parseInt(param[1]);
						progressbar_set(e("openwebrx-bar-server-cpu"),server_cpu_usage/100,"Server CPU ["+param[1]+"%]",server_cpu_usage>85);
						break;
					case "clients":
						var clients_num=parseInt(param[1]);
						progressbar_set(e("openwebrx-bar-clients"),clients_num/max_clients_num,"Clients ["+param[1]+"]",clients_num>max_clients_num*0.85);
						break;
					case "max_clients":
						max_clients_num=parseInt(param[1]);
						break;
					case "s":
						smeter_level=parseFloat(param[1]);
						setSmeterAbsoluteValue(smeter_level);
						break;
				}
			}
		/*}
		catch(err)
		{
			divlog("Received invalid message over WebSocket.");
		}*/
	}

}

function add_problem(what)
{
	problems_span=e("openwebrx-problems");
	for(var i=0;i<problems_span.children.length;i++) if(problems_span.children[i].innerHTML==what) return;
	new_span = document.createElement("span");
	new_span.innerHTML=what;
	problems_span.appendChild(new_span);
	window.setTimeout(function(ps,ns) {  ps.removeChild(ns); }, 1000,problems_span,new_span);
}

waterfall_measure_minmax=false;
waterfall_measure_minmax_now=false;
waterfall_measure_minmax_min=1e100;
waterfall_measure_minmax_max=-1e100;

function waterfall_measure_minmax_do(what)
{
	waterfall_measure_minmax_min=Math.min(waterfall_measure_minmax_min,Math.min.apply(Math,what));
	waterfall_measure_minmax_max=Math.max(waterfall_measure_minmax_max,Math.max.apply(Math,what));
}

function waterfall_measure_minmax_print()
{
	console.log("Waterfall | min = "+waterfall_measure_minmax_min.toString()+" dB | max = "+waterfall_measure_minmax_max.toString()+" dB");
}

function waterfall_add_queue(what)
{
	if(waterfall_measure_minmax) waterfall_measure_minmax_do(what);
	if(waterfall_measure_minmax_now) { waterfall_measure_minmax_do(what); waterfall_measure_minmax_now=false; waterfallColorsAuto(); }
	waterfall_queue.push(what);
}

function waterfall_dequeue()
{
	if(waterfall_queue.length) waterfall_add(waterfall_queue.shift());
	if(waterfall_queue.length>Math.max(fft_fps/2,20)) //in case of emergency
	{
		console.log("waterfall queue length:", waterfall_queue.length);
		add_problem("fft overflow");
		while(waterfall_queue.length) waterfall_add(waterfall_queue.shift());
	}
}

function on_ws_opened()
{
	ws.send("SET auth t=kiwi p=#");
	ws.send("SERVER DE CLIENT openwebrx.js W/F");
	divlog("WebSocket opened to "+ws_url);
}

var was_error=0;

function divlog(what, is_error)
{
	is_error=!!is_error;
	was_error |= is_error;
	console.log(what);
}

var audio_context;
var audio_initialized=0;
var volume = 1.0;
var volumeBeforeMute = 100.0;
var mute = false;

var audio_received = Array();
var audio_buffer_index = 0;
var audio_resampler;
var audio_codec=new sdrjs.ImaAdpcm();
var audio_compression="adpcm";
var audio_node;
//var audio_received_sample_rate = 48000;
var audio_input_buffer_size;

// Optimalise these if audio lags or is choppy:
var audio_buffer_size;
var audio_buffer_maximal_length_sec=3; //actual number of samples are calculated from sample rate
var audio_buffer_decrease_to_on_overrun_sec=2.2;
var audio_flush_interval_ms=500; //the interval in which audio_flush() is called

var audio_prepared_buffers = Array();
var audio_rebuffer;
var audio_last_output_buffer;
var audio_last_output_offset = 0;
var audio_buffering = false;
var audio_buffering_fill_to=4; //on audio underrun we wait until this n*audio_buffer_size samples are present
								//tnx to the hint from HA3FLT, now we have about half the response time! (original value: 10)

function gain_ff(gain_value,data) //great! solved clicking! will have to move to sdr.js
{
	for(var i=0;i<data.length;i++)
	data[i]*=gain_value;
	return data;
}

function audio_prepare(data)
{
	//audio_rebuffer.push(sdrjs.ConvertI16_F(data));//no resampling
	//audio_rebuffer.push(audio_resampler.process(sdrjs.ConvertI16_F(data)));//resampling without ADPCM
	if(audio_compression=="none")
		audio_rebuffer.push(audio_resampler.process(gain_ff(volume,sdrjs.ConvertI16_F(data))));//resampling without ADPCM
	else if(audio_compression=="adpcm")
		audio_rebuffer.push(audio_resampler.process(gain_ff(volume,sdrjs.ConvertI16_F(audio_codec.decode(data))))); //resampling & ADPCM
	else return;

	// console.log("prepare",data.length,audio_rebuffer.remaining());
	while(audio_rebuffer.remaining())
	{
		audio_prepared_buffers.push(audio_rebuffer.take());
		audio_buffer_current_count_debug++;
	}
	if(audio_buffering && audio_prepared_buffers.length>audio_buffering_fill_to) { console.log("buffers now: "+audio_prepared_buffers.length.toString()); audio_buffering=false; }
}


function audio_prepare_without_resampler(data)
{
	audio_rebuffer.push(sdrjs.ConvertI16_F(data));
	console.log("prepare",data.length,audio_rebuffer.remaining());
	while(audio_rebuffer.remaining())
	{
		audio_prepared_buffers.push(audio_rebuffer.take());
		audio_buffer_current_count_debug++;
	}
	if(audio_buffering && audio_prepared_buffers.length>audio_buffering_fill_to) audio_buffering=false;
}

function audio_prepare_old(data)
{
	//console.log("audio_prepare :: "+data.length.toString());
	//console.log("data.len = "+data.length.toString());
	var dopush=function()
	{
		console.log(audio_last_output_buffer);
		audio_prepared_buffers.push(audio_last_output_buffer);
		audio_last_output_offset=0;
		audio_last_output_buffer=new Float32Array(audio_buffer_size);
		audio_buffer_current_count_debug++;
	};

	var original_data_length=data.length;
	var f32data=new Float32Array(data.length);
	for(var i=0;i<data.length;i++) f32data[i]=data[i]/32768; //convert_i16_f
	data=audio_resampler.process(f32data);
	console.log(data,data.length,original_data_length);
	if(data.length==0) return;
	if(audio_last_output_offset+data.length<=audio_buffer_size)
	{	//array fits into output buffer
		for(var i=0;i<data.length;i++) audio_last_output_buffer[i+audio_last_output_offset]=data[i];
		audio_last_output_offset+=data.length;
		console.log("fits into; offset="+audio_last_output_offset.toString());
		if(audio_last_output_offset==audio_buffer_size) dopush();
	}
	else
	{	//array is larger than the remaining space in the output buffer
		var copied=audio_buffer_size-audio_last_output_offset;
		var remain=data.length-copied;
		for(var i=0;i<audio_buffer_size-audio_last_output_offset;i++) //fill the remaining space in the output buffer
			audio_last_output_buffer[i+audio_last_output_offset]=data[i];///32768;
		dopush();//push the output buffer and create a new one
		console.log("larger than; copied half: "+copied.toString()+", now at: "+audio_last_output_offset.toString());
		for(var i=0;i<remain;i++) //copy the remaining input samples to the new output buffer
			audio_last_output_buffer[i]=data[i+copied];///32768;
		audio_last_output_offset+=remain;
		console.log("larger than; remained: "+remain.toString()+", now at: "+audio_last_output_offset.toString());
	}
	if(audio_buffering && audio_prepared_buffers.length>audio_buffering_fill_to) audio_buffering=false;
}

if (!AudioBuffer.prototype.copyToChannel)
{ //Chrome 36 does not have it, Firefox does
	AudioBuffer.prototype.copyToChannel=function(input,channel) //input is Float32Array
	{
		var cd=this.getChannelData(channel);
		for(var i=0;i<input.length;i++) cd[i]=input[i];
	}
}

function audio_onprocess(e)
{
	//console.log("audio onprocess");
	
	if(audio_buffering) 
		return;
	if(audio_prepared_buffers.length==0) { 
		// audio_buffer_progressbar_update(); /*add_problem("audio underrun");*/ 
		audio_buffering=true; 
	}
	else { 
		e.outputBuffer.copyToChannel(audio_prepared_buffers.shift(),0); 
	}
}

var audio_buffer_total_average_level=0;
var audio_buffer_total_average_level_length=0;
var audio_overrun_cnt = 0;
var audio_underrun_cnt = 0;

function audio_flush()
{
	flushed=false;
	we_have_more_than = function(sec) { 
		return sec * audio_context.sampleRate < audio_prepared_buffers.length * audio_buffer_size; 
	}

	if(we_have_more_than(audio_buffer_maximal_length_sec)) while(we_have_more_than(audio_buffer_decrease_to_on_overrun_sec))
	{
		// if(!flushed) audio_buffer_progressbar_update();
		flushed=true;
		audio_prepared_buffers.shift();
	}
	
	//if(flushed) add_problem("audio overrun");
}

function webrx_set_param(what, value)
{
	ws.send("SET "+what+"="+value.toString());
}

var starting_mute = false;

function parsehash()
{
	if(h=window.location.hash)
	{
		h.substring(1).split(",").forEach(function(x){
			harr=x.split("=");
			//console.log(harr);
			if(harr[0]=="mute") toggleMute();
			else if(harr[0]=="mod") starting_mod = harr[1];
			else if(harr[0]=="sql") 
			{ 
				e("openwebrx-panel-squelch").value=harr[1]; 
				updateSquelch(); 
			}
			else if(harr[0]=="freq") 
			{
				console.log(parseInt(harr[1]));
				console.log(center_freq);
				starting_offset_frequency = -14406000; //parseInt(harr[1])-center_freq;
			}
		});

	}
}

function audio_preinit()
{
	try
	{
		window.AudioContext = window.AudioContext||window.webkitAudioContext;
		audio_context = new AudioContext();
	}
	catch(e)
	{
		divlog('Your browser does not support Web Audio API, which is required for WebRX to run. Please upgrade to a HTML5 compatible browser.', 1);
		return;
	}

	if(audio_context.sampleRate<44100*2)
		audio_buffer_size = 4096;
	else if(audio_context.sampleRate>=44100*2 && audio_context.sampleRate<44100*4)
		audio_buffer_size = 4096 * 2;
	else if(audio_context.sampleRate>44100*4)
		audio_buffer_size = 4096 * 4;

	audio_rebuffer = new sdrjs.Rebuffer(audio_buffer_size,sdrjs.REBUFFER_FIXED);
	audio_last_output_buffer = new Float32Array(audio_buffer_size);

	//we send our setup packet
	parsehash();

	audio_calculate_resampling(audio_context.sampleRate);
	audio_resampler = new sdrjs.RationalResamplerFF(audio_client_resampling_factor,1);
	ws.send("SET output_rate="+audio_server_output_rate.toString()+" action=start"); //now we'll get AUD packets as well

}

function audio_init()
{
    if(is_chrome) audio_context.resume()
	updateVolume(100);

	if(audio_client_resampling_factor==0) return; //if failed to find a valid resampling factor...

	audio_debug_time_start=(new Date()).getTime();
	audio_debug_time_last_start=audio_debug_time_start;

	//https://github.com/0xfe/experiments/blob/master/www/tone/js/sinewave.js
	audio_initialized=1; // only tell on_ws_recv() not to call it again


	//on Chrome v36, createJavaScriptNode has been replaced by createScriptProcessor
	createjsnode_function = (audio_context.createJavaScriptNode == undefined)?audio_context.createScriptProcessor.bind(audio_context):audio_context.createJavaScriptNode.bind(audio_context);
	audio_node = createjsnode_function(audio_buffer_size, 0, 1);
	audio_node.onaudioprocess = audio_onprocess;
	audio_node.connect(audio_context.destination);
	// --- Resampling ---
	//https://github.com/grantgalitz/XAudioJS/blob/master/XAudioServer.js
	//audio_resampler = new Resampler(audio_received_sample_rate, audio_context.sampleRate, 1, audio_buffer_size, true);
	//audio_input_buffer_size = audio_buffer_size*(audio_received_sample_rate/audio_context.sampleRate);
	webrx_set_param("audio_rate",audio_context.sampleRate); //Don't try to resample //TODO remove this

	window.setInterval(audio_flush,audio_flush_interval_ms);
	divlog('Web Audio API succesfully initialized, sample rate: '+audio_context.sampleRate.toString()+ " sps");
	/*audio_source=audio_context.createBufferSource();
   audio_buffer = audio_context.createBuffer(xhr.response, false);
	audio_source.buffer = buffer;
	audio_source.noteOn(0);*/
	demodulator_analog_replace("lsb");
	demodulators[0].offset_frequency = -14406000;
	demodulators[0].set();
}

function on_ws_closed()
{
	try
	{
		audio_node.disconnect();
	}
	catch (dont_care) {}
	divlog("WebSocket has closed unexpectedly. Please reload the page.", 1);
}

function on_ws_error(event)
{
	divlog("WebSocket error.",1);
}

String.prototype.startswith=function(str){ return this.indexOf(str) == 0; }; //http://stackoverflow.com/questions/646628/how-to-check-if-a-string-startswith-another-string

function open_websocket(url)
{
	ws_url=url;
	if (!("WebSocket" in window))
		divlog("Your browser does not support WebSocket, which is required for WebRX to run. Please upgrade to a HTML5 compatible browser.");
	ws = new WebSocket(ws_url);
	ws.onopen = on_ws_opened;
	ws.onmessage = on_ws_recv;
	ws.onclose = on_ws_closed;
	ws.binaryType = "arraybuffer";
	window.onbeforeunload = function() { //http://stackoverflow.com/questions/4812686/closing-websocket-correctly-html5-javascript
		ws.onclose = function () {};
		ws.close();
	};
	ws.onerror = on_ws_error;

	return ws;
}

var rt = function (s,n) {return s.replace(/[a-zA-Z]/g,function(c){return String.fromCharCode((c<="Z"?90:122)>=(c=c.charCodeAt(0)+n)?c:c-26);});}
var irt = function (s,n) {return s.replace(/[a-zA-Z]/g,function(c){return String.fromCharCode((c>="a"?97:65)<=(c=c.charCodeAt(0)-n)?c:c+26);});}
var sendmail2 = function (s) { window.location.href="mailto:"+irt(s.replace("=",String.fromCharCode(0100)).replace("$","."),8); }

var audio_debug_time_start=0;
var audio_debug_time_last_start=0;

function debug_audio()
{
	if(audio_debug_time_start==0) return; //audio_init has not been called
	time_now=(new Date()).getTime();
	audio_debug_time_since_last_call=(time_now-audio_debug_time_last_start)/1000;
	audio_debug_time_last_start=time_now; //now
	audio_debug_time_taken=(time_now-audio_debug_time_start)/1000;
	kbps_mult=(audio_compression=="adpcm")?8:16;
	var audio_speed_value=audio_buffer_current_size_debug*kbps_mult/audio_debug_time_since_last_call;
	var audio_output_value=(audio_buffer_current_count_debug*audio_buffer_size)/audio_debug_time_taken;
	var network_speed_value=debug_ws_data_received/audio_debug_time_taken;
	audio_buffer_current_size_debug=0;
	if(waterfall_measure_minmax) waterfall_measure_minmax_print();
}

function demodulator_analog_replace_last() { demodulator_analog_replace(last_analog_demodulator_subtype); }

/*
  _____  _       _                     _           
 |  __ \(_)     (_)                   | |          
 | |  | |_  __ _ _ _ __ ___   ___   __| | ___  ___ 
 | |  | | |/ _` | | '_ ` _ \ / _ \ / _` |/ _ \/ __|
 | |__| | | (_| | | | | | | | (_) | (_| |  __/\__ \
 |_____/|_|\__, |_|_| |_| |_|\___/ \__,_|\___||___/
            __/ |                                  
           |___/                                   
*/

secondary_demod = false;
secondary_demod_offset_freq = 0;
secondary_demod_waterfall_queue = [];

function demodulator_digital_replace_last() 
{ 
    demodulator_digital_replace(last_digital_demodulator_subtype); 
    secondary_demod_listbox_update();
}
function demodulator_digital_replace(subtype)
{
    switch(subtype) 
    {
    case "bpsk31":
    case "rtty":
        secondary_demod_start(subtype);
        demodulator_analog_replace('usb', true);
        break;
    }
    // toggle_panel("openwebrx-panel-digimodes", true);
}

function secondary_demod_create_canvas()
{
	var new_canvas = document.createElement("canvas");
	new_canvas.width=secondary_fft_size;
	new_canvas.height=$(secondary_demod_canvas_container).height();
	new_canvas.style.width=$(secondary_demod_canvas_container).width()+"px";
	new_canvas.style.height=$(secondary_demod_canvas_container).height()+"px";
    console.log(new_canvas.width, new_canvas.height, new_canvas.style.width, new_canvas.style.height);
	secondary_demod_current_canvas_actual_line=new_canvas.height-1;
	$(secondary_demod_canvas_container).children().last().before(new_canvas);
    return new_canvas;
}

function secondary_demod_remove_canvases()
{
    $(secondary_demod_canvas_container).children("canvas").remove();
}

function secondary_demod_init_canvases()
{
    secondary_demod_remove_canvases();
    secondary_demod_canvases=[];
    secondary_demod_canvases.push(secondary_demod_create_canvas());
    secondary_demod_canvases.push(secondary_demod_create_canvas());
    secondary_demod_canvases[0].openwebrx_top=-$(secondary_demod_canvas_container).height();
    secondary_demod_canvases[1].openwebrx_top=0;
    secondary_demod_canvases_update_top();
    secondary_demod_current_canvas_context = secondary_demod_canvases[0].getContext("2d");
    secondary_demod_current_canvas_actual_line=$(secondary_demod_canvas_container).height()-1;
    secondary_demod_current_canvas_index=0;
    secondary_demod_canvases_initialized=true;
}

function secondary_demod_swap_canvases()
{
    console.log("swap");
    secondary_demod_canvases[0+!secondary_demod_current_canvas_index].openwebrx_top-=$(secondary_demod_canvas_container).height()*2;
    secondary_demod_current_canvas_index=0+!secondary_demod_current_canvas_index;
    secondary_demod_current_canvas_context = secondary_demod_canvases[secondary_demod_current_canvas_index].getContext("2d");
    secondary_demod_current_canvas_actual_line=$(secondary_demod_canvas_container).height()-1;
}

function secondary_demod_start(subtype) 
{ 
    secondary_demod_canvases_initialized = false;
    ws.send("SET secondary_mod="+subtype); 
    secondary_demod = subtype; 
}

function secondary_demod_set()
{
    ws.send("SET secondary_offset_freq="+secondary_demod_offset_freq.toString());
}

function secondary_demod_stop()
{
    ws.send("SET secondary_mod=off");
    secondary_demod = false; 
    secondary_demod_waterfall_queue = [];
}

function secondary_demod_waterfall_add_queue(x)
{
    secondary_demod_waterfall_queue.push(x);
}

function secondary_demod_push_binary_data(x)
{
    secondary_demod_push_data(Array.from(x).map( y => (y)?"1":"0" ).join(""));
}

function secondary_demod_close_window()
{
    secondary_demod_stop();
    // toggle_panel("openwebrx-panel-digimodes", false);
}

secondary_demod_fft_offset_db=30; //need to calculate that later

secondary_demod_waiting_for_set = false;
function secondary_demod_update_channel_freq_from_event(evt)
{
    if(typeof evt !== "undefined")
    {
        var relativeX=(evt.offsetX)?evt.offsetX:evt.layerX;
        secondary_demod_channel_freq=secondary_demod_low_cut + 
            (relativeX/$(secondary_demod_canvas_container).width()) * (secondary_demod_high_cut-secondary_demod_low_cut);
    }
    //console.log("toset:", secondary_demod_channel_freq);
    if(!secondary_demod_waiting_for_set)
    {
        secondary_demod_waiting_for_set = true;
        window.setTimeout(()=>{
            ws.send("SET secondary_offset_freq="+Math.floor(secondary_demod_channel_freq));
            //console.log("doneset:", secondary_demod_channel_freq);
            secondary_demod_waiting_for_set = false;
        }, 50);
    }
    secondary_demod_update_marker();
}