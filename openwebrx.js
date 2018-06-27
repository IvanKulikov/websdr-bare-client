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
                        // secondary_demod_init_canvases();
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
var audio_input_buffer_size;

// Optimalise these if audio lags or is choppy:
var audio_buffer_size;
var audio_buffer_maximal_length_sec=3; //actual number of samples are calculated from sample rate // 3
var audio_buffer_decrease_to_on_overrun_sec=2.2;
var audio_flush_interval_ms=100; //the interval in which audio_flush() is called

var audio_prepared_buffers = Array();
var audio_rebuffer;
var audio_last_output_buffer;
var audio_last_output_offset = 0;
var audio_buffering = false;
var audio_buffering_fill_to=3; //on audio underrun we wait until this n*audio_buffer_size samples are present
								//tnx to the hint from HA3FLT, now we have about half the response time! (original value: 10)

function gain_ff(gain_value,data) //great! solved clicking! will have to move to sdr.js
{
	for(var i=0;i<data.length;i++)
	data[i]*=gain_value;
	return data;
}

function audio_prepare(data)
{
	// audio_rebuffer.push(sdrjs.ConvertI16_F(data));//no resampling
	// audio_rebuffer.push(audio_resampler.process(sdrjs.ConvertI16_F(data)));//resampling without ADPCM
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
	if(audio_buffering) 
		return;
	if(audio_prepared_buffers.length==0) { 
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
		if(!flushed) audio_buffer_progressbar_update();
		flushed=true;
		audio_prepared_buffers.shift();
	}
	
	if(flushed) add_problem("audio overrun");
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
				starting_offset_frequency = parseInt(harr[1])-center_freq; // -14406000; //parseInt(harr[1])-center_freq;
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

	//https://github.com/0xfe/experiments/blob/master/www/tone/js/sinewave.js
	audio_initialized=1; // only tell on_ws_recv() not to call it again


	//on Chrome v36, createJavaScriptNode has been replaced by createScriptProcessor
	createjsnode_function = (audio_context.createJavaScriptNode == undefined) 
		? audio_context.createScriptProcessor.bind(audio_context) 
		: audio_context.createJavaScriptNode.bind(audio_context);
	audio_node = createjsnode_function(audio_buffer_size, 0, 1);
	audio_node.onaudioprocess = audio_onprocess;
	audio_node.connect(audio_context.destination);

	window.setInterval(audio_flush, audio_flush_interval_ms);
	divlog('Web Audio API succesfully initialized, sample rate: '+audio_context.sampleRate.toString()+ " sps");
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