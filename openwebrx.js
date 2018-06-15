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
//alert("ios="+ios.toString()+"  "+navigator.userAgent);

function init_rx_photo()
{
	e("webrx-top-photo-clip").style.maxHeight=rx_photo_height.toString()+"px";
	window.setTimeout(function() { animate(e("webrx-rx-photo-title"),"opacity","",1,0,1,500,30); },1000);
	window.setTimeout(function() { animate(e("webrx-rx-photo-desc"),"opacity","",1,0,1,500,30); },1500);
	window.setTimeout(function() { close_rx_photo() },2500);
}

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

function close_rx_photo()
{
	rx_photo_state=0;
	animate_to(e("webrx-top-photo-clip"),"maxHeight","px",67,0.93,1000,60,function(){resize_waterfall_container(true);});
	e("openwebrx-rx-details-arrow-down").style.display="block";
	e("openwebrx-rx-details-arrow-up").style.display="none";
}

function open_rx_photo()
{
	rx_photo_state=1;
	e("webrx-rx-photo-desc").style.opacity=1;
	e("webrx-rx-photo-title").style.opacity=1;
	animate_to(e("webrx-top-photo-clip"),"maxHeight","px",rx_photo_height,0.93,1000,60,function(){resize_waterfall_container(true);});
	e("openwebrx-rx-details-arrow-down").style.display="none";
	e("openwebrx-rx-details-arrow-up").style.display="block";
}

function style_value(of_what,which)
{
	if(of_what.currentStyle) return of_what.currentStyle[which];
	else if (window.getComputedStyle) return document.defaultView.getComputedStyle(of_what,null).getPropertyValue(which);
}

function updateVolume(n)
{
	volume = n / 100;
}

function zoomInOneStep ()  { zoom_set(zoom_level+1); }
function zoomOutOneStep () { zoom_set(zoom_level-1); }
function zoomInTotal ()    { zoom_set(zoom_levels.length-1); }
function zoomOutTotal ()   { zoom_set(0); }
function setSquelchDefault() { e("openwebrx-panel-squelch").value=0; }
function setSquelchToAuto() { e("openwebrx-panel-squelch").value=(getLogSmeterValue(smeter_level)+10).toString(); updateSquelch(); }
function updateSquelch()
{
	var sliderValue=parseInt(e("openwebrx-panel-squelch").value);
	var outputValue=(sliderValue==parseInt(e("openwebrx-panel-squelch").min))?0:getLinearSmeterValue(sliderValue);
	ws.send("SET squelch_level="+outputValue.toString());
}

function updateWaterfallColors(which)
{
	wfmax=e("openwebrx-waterfall-color-max");
	wfmin=e("openwebrx-waterfall-color-min");
	if(parseInt(wfmin.value)>=parseInt(wfmax.value))
	{
			if(!which) wfmin.value=(parseInt(wfmax.value)-1).toString();
			else wfmax.value=(parseInt(wfmin.value)+1).toString();
	}
	waterfall_min_level=parseInt(wfmin.value);
	waterfall_max_level=parseInt(wfmax.value);
}
function waterfallColorsDefault()
{
	waterfall_min_level=waterfall_min_level_default;
	waterfall_max_level=waterfall_max_level_default;
	e("openwebrx-waterfall-color-min").value=waterfall_min_level.toString();
	e("openwebrx-waterfall-color-max").value=waterfall_max_level.toString();
}

function waterfallColorsAuto()
{
	e("openwebrx-waterfall-color-min").value=(waterfall_measure_minmax_min-waterfall_auto_level_margin[0]).toString();
	e("openwebrx-waterfall-color-max").value=(waterfall_measure_minmax_max+waterfall_auto_level_margin[1]).toString();
	updateWaterfallColors(0);
}

function setSmeterRelativeValue(value)
{
	if(value<0) value=0;
	if(value>1.0) value=1.0;
	var bar=e("openwebrx-smeter-bar");
	var outer=e("openwebrx-smeter-outer");
	bar.style.width=(outer.offsetWidth*value).toString()+"px";
	bgRed="linear-gradient(to top, #ff5939 , #961700)";
	bgGreen="linear-gradient(to top, #22ff2f , #008908)";
	bgYellow="linear-gradient(to top, #fff720 , #a49f00)";
	bar.style.background=(value>0.9)?bgRed:((value>0.7)?bgYellow:bgGreen);
	//bar.style.backgroundColor=(value>0.9)?"#ff5939":((value>0.7)?"#fff720":"#22ff2f");
}

function getLogSmeterValue(value)
{
	return 10*Math.log10(value);
}

function getLinearSmeterValue(db_value)
{
	return Math.pow(10,db_value/10);
}

function setSmeterAbsoluteValue(value) //the value that comes from `csdr squelch_and_smeter_cc`
{
	var logValue=getLogSmeterValue(value);
	var lowLevel=waterfall_min_level-20;
	var highLevel=waterfall_max_level+20;
	var percent=(logValue-lowLevel)/(highLevel-lowLevel);
	setSmeterRelativeValue(percent);
	e("openwebrx-smeter-db").innerHTML=logValue.toFixed(1)+" dB";
}

function typeInAnimation(element,timeout,what,onFinish)
{
	if(!what) { onFinish(); return; }
	element.innerHTML+=what[0];
	window.setTimeout(	function(){typeInAnimation(element,timeout,what.substring(1),onFinish);}, timeout );
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
	// mkenvelopes(get_visible_freq_range());
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

var scale_ctx;
var scale_canvas;

function scale_setup()
{
	e("webrx-actual-freq").innerHTML=format_frequency("{x} MHz",canvas_get_frequency(window.innerWidth/2),1e6,4);
	scale_canvas=e("openwebrx-scale-canvas");
	scale_ctx=scale_canvas.getContext("2d");
	scale_canvas.addEventListener("mousedown", scale_canvas_mousedown, false);
	scale_canvas.addEventListener("mousemove", scale_canvas_mousemove, false);
	scale_canvas.addEventListener("mouseup", scale_canvas_mouseup, false);
	resize_scale();
}

var scale_canvas_drag_params={
	mouse_down: false,
	drag: false,
	start_x: 0,
	key_modifiers: {shiftKey:false, altKey: false, ctrlKey: false}
};

function scale_canvas_mousedown(evt)
{
	with(scale_canvas_drag_params)
	{
		mouse_down=true;
		drag=false;
		start_x=evt.pageX;
		key_modifiers.shiftKey=evt.shiftKey;
		key_modifiers.altKey=evt.altKey;
		key_modifiers.ctrlKey=evt.ctrlKey;
	}
	evt.preventDefault();
}

function scale_offset_freq_from_px(x, visible_range)
{
	if(typeof visible_range === "undefined") visible_range=get_visible_freq_range();
	return (visible_range.start+visible_range.bw*(x/canvas_container.clientWidth))-center_freq;
}

var scale_markers_levels=[
	{
		"large_marker_per_hz":10000000, //large
		"estimated_text_width":70,
		"format":"{x} MHz",
		"pre_divide":1000000,
		"decimals":0
	},
	{
		"large_marker_per_hz":5000000,
		"estimated_text_width":70,
		"format":"{x} MHz",
		"pre_divide":1000000,
		"decimals":0
	},
	{
		"large_marker_per_hz":1000000,
		"estimated_text_width":70,
		"format":"{x} MHz",
		"pre_divide":1000000,
		"decimals":0
	},
	{
		"large_marker_per_hz":500000,
		"estimated_text_width":70,
		"format":"{x} MHz",
		"pre_divide":1000000,
		"decimals":1
	},
	{
		"large_marker_per_hz":100000,
		"estimated_text_width":70,
		"format":"{x} MHz",
		"pre_divide":1000000,
		"decimals":1
	},
	{
		"large_marker_per_hz":50000,
		"estimated_text_width":70,
		"format":"{x} MHz",
		"pre_divide":1000000,
		"decimals":2
	},
	{
		"large_marker_per_hz":10000,
		"estimated_text_width":70,
		"format":"{x} MHz",
		"pre_divide":1000000,
		"decimals":2
	},
	{
		"large_marker_per_hz":5000,
		"estimated_text_width":70,
		"format":"{x} MHz",
		"pre_divide":1000000,
		"decimals":3
	},
	{
		"large_marker_per_hz":1000,
		"estimated_text_width":70,
		"format":"{x} MHz",
		"pre_divide":1000000,
		"decimals":1
	}
];
var scale_min_space_bw_texts=50;
var scale_min_space_bw_small_markers=7;

function get_scale_mark_spacing(range)
{
	out={};
	fcalc=function(freq)
	{
		out.numlarge=(range.bw/freq);
		out.large=canvas_container.clientWidth/out.numlarge; 	//distance between large markers (these have text)
		out.ratio=5; 														//(ratio-1) small markers exist per large marker
		out.small=out.large/out.ratio; 								//distance between small markers
		if(out.small<scale_min_space_bw_small_markers) return false;
		if(out.small/2>=scale_min_space_bw_small_markers&&freq.toString()[0]!="5") {out.small/=2; out.ratio*=2; }
		out.smallbw=freq/out.ratio;
		return true;
	}
	for(i=scale_markers_levels.length-1;i>=0;i--)
	{
		mp=scale_markers_levels[i];
		if (!fcalc(mp.large_marker_per_hz)) continue;
		//console.log(mp.large_marker_per_hz);
		//console.log(out);
		if (out.large-mp.estimated_text_width>scale_min_space_bw_texts) break;
	}
	out.params=mp;
	return out;
}

function mkscale()
{

}

function resize_scale()
{
	scale_ctx.canvas.width  = window.innerWidth;
	scale_ctx.canvas.height = 47;
	mkscale();
}

function canvas_mouseover(evt)
{
	if(!waterfall_setup_done) return;
	//e("webrx-freq-show").style.visibility="visible";
}

function canvas_mouseout(evt)
{
	if(!waterfall_setup_done) return;
	//e("webrx-freq-show").style.visibility="hidden";
}

function canvas_get_freq_offset(relativeX)
{
	rel=(relativeX/canvases[0].clientWidth);
	return Math.round((bandwidth*rel)-(bandwidth/2));
}

function canvas_get_frequency(relativeX)
{
	return center_freq+canvas_get_freq_offset(relativeX);
}

/*function canvas_format_frequency(relativeX)
{
	return (canvas_get_frequency(relativeX)/1e6).toFixed(3)+" MHz";
}*/

function format_frequency(format, freq_hz, pre_divide, decimals)
{
	out=format.replace("{x}",(freq_hz/pre_divide).toFixed(decimals));
	at=out.indexOf(".")+4;
	while(decimals>3)
	{
		out=out.substr(0,at)+","+out.substr(at);
		at+=4;
		decimals-=3;
	}
	return out;
}

canvas_drag=false;
canvas_drag_min_delta=1;
canvas_mouse_down=false;

function canvas_mousedown(evt)
{
	canvas_mouse_down=true;
	canvas_drag=false;
	canvas_drag_last_x=canvas_drag_start_x=evt.pageX;
	canvas_drag_last_y=canvas_drag_start_y=evt.pageY;
	evt.preventDefault(); //don't show text selection mouse pointer
}

function canvas_mousemove(evt)
{
	if(!waterfall_setup_done) return;
	//element=e("webrx-freq-show");
	relativeX=(evt.offsetX)?evt.offsetX:evt.layerX;
	/*realX=(relativeX-element.clientWidth/2);
	maxX=(canvases[0].clientWidth-element.clientWidth);
	if(realX>maxX) realX=maxX;
	if(realX<0) realX=0;
	element.style.left=realX.toString()+"px";*/
	if(canvas_mouse_down)
	{
		if(!canvas_drag&&Math.abs(evt.pageX-canvas_drag_start_x)>canvas_drag_min_delta)
		{
			canvas_drag=true;
			canvas_container.style.cursor="move";
		}
		if(canvas_drag)
		{
			var deltaX=canvas_drag_last_x-evt.pageX;
			var deltaY=canvas_drag_last_y-evt.pageY;
			//zoom_center_where=zoom_center_where_calc(evt.pageX);
			var dpx=range.hps*deltaX;
			if(
				!(zoom_center_rel+dpx>(bandwidth/2-canvas_container.clientWidth*(1-zoom_center_where)*range.hps)) &&
				!(zoom_center_rel+dpx<-bandwidth/2+canvas_container.clientWidth*zoom_center_where*range.hps)
			) { zoom_center_rel+=dpx; }
//			-((canvases_new_width*(0.5+zoom_center_rel/bandwidth))-(winsize*zoom_center_where));
			resize_canvases(false);
			canvas_drag_last_x=evt.pageX;
			canvas_drag_last_y=evt.pageY;
			mkscale();
		}
	}
	else e("webrx-mouse-freq").innerHTML=format_frequency("{x} MHz",canvas_get_frequency(relativeX),1e6,4);
}

function canvas_container_mouseout(evt)
{
	canvas_end_drag();
}

//function body_mouseup() { canvas_end_drag(); console.log("body_mouseup"); }
//function window_mouseout() { canvas_end_drag(); console.log("document_mouseout"); }

function canvas_mouseup(evt)
{
	if(!waterfall_setup_done) return;
	relativeX=(evt.offsetX)?evt.offsetX:evt.layerX;

	if(!canvas_drag)
	{
		//ws.send("SET offset_freq="+canvas_get_freq_offset(relativeX).toString());
		demodulator_set_offset_frequency(0, canvas_get_freq_offset(relativeX));
		e("webrx-actual-freq").innerHTML=format_frequency("{x} MHz",canvas_get_frequency(relativeX),1e6,4);
	}
	else
	{
		canvas_end_drag();
	}
	canvas_mouse_down=false;
}

function canvas_end_drag()
{
	canvas_container.style.cursor="crosshair";
	canvas_mouse_down=false;
}

function zoom_center_where_calc(screenposX)
{
	//return (screenposX-(window.innerWidth-canvas_container.clientWidth))/canvas_container.clientWidth;
	return screenposX/canvas_container.clientWidth;
}

function canvas_mousewheel(evt)
{
	if(!waterfall_setup_done) return;
	//var i=Math.abs(evt.wheelDelta);
	//var dir=(i/evt.wheelDelta)<0;
	//console.log(evt);
	var relativeX=(evt.offsetX)?evt.offsetX:evt.layerX;
	var dir=(evt.deltaY/Math.abs(evt.deltaY))>0;
	//console.log(dir);
	//i/=120;
	/*while (i--)*/ zoom_step(dir, relativeX, zoom_center_where_calc(evt.pageX));
	evt.preventDefault();
	//evt.returnValue = false; //disable scrollbar move
}


zoom_max_level_hps=33; //Hz/pixel
zoom_levels_count=14;

function get_zoom_coeff_from_hps(hps)
{
	var shown_bw=(window.innerWidth*hps);
	return bandwidth/shown_bw;
}

zoom_levels=[1];
zoom_level=0;
zoom_freq=0;
zoom_offset_px=0;
zoom_center_rel=0;
zoom_center_where=0;

smeter_level=0;

function mkzoomlevels()
{
	zoom_levels=[1];
	maxc=get_zoom_coeff_from_hps(zoom_max_level_hps);
	if(maxc<1) return;
	// logarithmic interpolation
	zoom_ratio = Math.pow(maxc, 1/zoom_levels_count);
	for(i=1;i<zoom_levels_count;i++)
		zoom_levels.push(Math.pow(zoom_ratio, i));
}

function zoom_step(out, where, onscreen)
{
	if((out&&zoom_level==0)||(!out&&zoom_level>=zoom_levels_count-1)) return;
	if(out) --zoom_level;
	else ++zoom_level;

	zoom_center_rel=canvas_get_freq_offset(where);
	//console.log("zoom_step || zlevel: "+zoom_level.toString()+" zlevel_val: "+zoom_levels[zoom_level].toString()+" zoom_center_rel: "+zoom_center_rel.toString());
	zoom_center_where=onscreen;
	//console.log(zoom_center_where, zoom_center_rel, where);
	resize_canvases(true);
	mkscale();
}

function zoom_set(level)
{
	if(!(level>=0&&level<=zoom_levels.length-1)) return;
	level=parseInt(level);
	zoom_level = level;
	//zoom_center_rel=canvas_get_freq_offset(-canvases[0].offsetLeft+canvas_container.clientWidth/2); //zoom to screen center instead of demod envelope
	zoom_center_rel=demodulators[0].offset_frequency;
	zoom_center_where=0.5+(zoom_center_rel/bandwidth); //this is a kind of hack
	console.log(zoom_center_where, zoom_center_rel, -canvases[0].offsetLeft+canvas_container.clientWidth/2);
	resize_canvases(true);
	mkscale();
}

function zoom_calc()
{
	winsize=canvas_container.clientWidth;
	var canvases_new_width=winsize*zoom_levels[zoom_level];
	zoom_offset_px=-((canvases_new_width*(0.5+zoom_center_rel/bandwidth))-(winsize*zoom_center_where));
	if(zoom_offset_px>0) zoom_offset_px=0;
	if(zoom_offset_px<winsize-canvases_new_width)
		zoom_offset_px=winsize-canvases_new_width;
	//console.log("zoom_calc || zopx:"+zoom_offset_px.toString()+ " maxoff:"+(winsize-canvases_new_width).toString()+" relval:"+(0.5+zoom_center_rel/bandwidth).toString() );
}

function resize_waterfall_container(check_init)
{
	if(check_init&&!waterfall_setup_done) return;
	var numHeight;
	mathbox_container.style.height=canvas_container.style.height=(numHeight=window.innerHeight-e("webrx-top-container").clientHeight-e("openwebrx-scale-container").clientHeight).toString()+"px";
	if(mathbox)
	{
		//mathbox.three.camera.aspect = document.body.offsetWidth / numHeight;
  		//mathbox.three.camera.updateProjectionMatrix();
		mathbox.three.renderer.setSize(document.body.offsetWidth, numHeight);
		console.log(document.body.offsetWidth, numHeight);
	}

}

audio_server_output_rate=11025;
audio_client_resampling_factor=4;


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

function audio_flush_notused()
{
	if (audio_buffer_current_size>audio_buffer_maximal_length_sec*audio_context.sampleRate)
	{
		add_problem("audio overrun");
		console.log("audio_flush() :: size: "+audio_buffer_current_size.toString()+" allowed: "+(audio_buffer_maximal_length_sec*audio_context.sampleRate).toString());
		while (audio_buffer_current_size>audio_buffer_maximal_length_sec*audio_context.sampleRate*0.5)
		{
			audio_buffer_current_size-=audio_received[0].length;
			audio_received.splice(0,1);
		}
	}
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

function waterfall_mkcolor(db_value, waterfall_colors_arg)
{
	if(typeof waterfall_colors_arg === 'undefined') waterfall_colors_arg = waterfall_colors;
	if(db_value<waterfall_min_level) db_value=waterfall_min_level;
	if(db_value>waterfall_max_level) db_value=waterfall_max_level;
	full_scale=waterfall_max_level-waterfall_min_level;
	relative_value=db_value-waterfall_min_level;
	value_percent=relative_value/full_scale;
	percent_for_one_color=1/(waterfall_colors_arg.length-1);
	index=Math.floor(value_percent/percent_for_one_color);
	remain=(value_percent-percent_for_one_color*index)/percent_for_one_color;
	return color_between(waterfall_colors_arg[index+1],waterfall_colors_arg[index],remain);
}

function color_between(first, second, percent)
{
	output=0;
	for(i=0;i<4;i++)
	{
		add = ((((first&(0xff<<(i*8)))>>>0)*percent) + (((second&(0xff<<(i*8)))>>>0)*(1-percent))) & (0xff<<(i*8));
		output |= add>>>0;
	}
	return output>>>0;
}


var canvas_context;
var canvases = [];
var canvas_default_height = 200;
var canvas_container;
var canvas_phantom;

var mathbox_shift = function()
{
	if(mathbox_data_current_depth < mathbox_data_max_depth) mathbox_data_current_depth++;
	if(mathbox_data_index+1>=mathbox_data_max_depth) mathbox_data_index = 0;
	else mathbox_data_index++;
	mathbox_data_global_index++;
}

var mathbox_clear_data = function()
{
	mathbox_data_index = 50;
	mathbox_data_current_depth = 0;
}

var mathbox_get_data_line = function(x)
{
	return (mathbox_data_max_depth + mathbox_data_index + x - 1) % mathbox_data_max_depth;
}

var mathbox_data_index_valid = function(x)
{
	return x>mathbox_data_max_depth-mathbox_data_current_depth;
}

var MATHBOX_MODES =
{
	UNINITIALIZED: 0,
	NONE: 1,
	WATERFALL: 2,
	CONSTELLATION: 3
};
var mathbox_mode = MATHBOX_MODES.UNINITIALIZED;
var mathbox;
var mathbox_element;

function mathbox_init()
{
	//mathbox_waterfall_history_length is defined in the config
	mathbox_data_max_depth = fft_fps * mathbox_waterfall_history_length; //how many lines can the buffer store
	mathbox_data_current_depth = 0; //how many lines are in the buffer currently
	mathbox_data_index = 0; //the index of the last empty line / the line to be overwritten
	mathbox_data = new Float32Array(fft_size * mathbox_data_max_depth);
	mathbox_data_global_index = 0;
	mathbox_correction_for_z = 0;

	mathbox = mathBox({
      plugins: ['core', 'controls', 'cursor', 'stats'],
      controls: { klass: THREE.OrbitControls },
    });
    three = mathbox.three;
    if(typeof three == "undefined") divlog("3D waterfall cannot be initialized because WebGL is not supported in your browser.", true);

    three.renderer.setClearColor(new THREE.Color(0x808080), 1.0);
	mathbox_container.appendChild((mathbox_element=three.renderer.domElement));
    view = mathbox
    .set({
      scale: 1080,
      focus: 3,
    })
    .camera({
      proxy: true,
      position: [-2, 1, 3],
    })
    .cartesian({
      range: [[-1, 1], [0, 1], [0, 1]],
      scale: [2, 2/3, 1],
    });

    view.axis({
      axis: 1,
      width: 3,
	  color: "#fff",
  });
    view.axis({
      axis: 2,
      width: 3,
	  color: "#fff",
	  //offset: [0, 0, 0],
  });
    view.axis({
      axis: 3,
      width: 3,
	  color: "#fff",
  });

    view.grid({
      width: 2,
      opacity: 0.5,
      axes: [1, 3],
      zOrder: 1,
	  color: "#fff",
    });

    //var remap = function (v) { return Math.sqrt(.5 + .5 * v); };


	var remap = function(x,z,t)
	{
		var currentTimePos = mathbox_data_global_index/(fft_fps*1.0);
		var realZAdd = (-(t-currentTimePos)/mathbox_waterfall_history_length);
		var zAdd = realZAdd - mathbox_correction_for_z;
		if(zAdd<-0.2 || zAdd>0.2) { mathbox_correction_for_z = realZAdd; }

		var xIndex = Math.trunc(((x+1)/2.0)*fft_size); //x: frequency
		var zIndex = Math.trunc(z*(mathbox_data_max_depth-1)); //z: time
		var realZIndex = mathbox_get_data_line(zIndex);
		if(!mathbox_data_index_valid(zIndex)) return {y: undefined, dBValue: undefined, zAdd: 0 };
		//if(realZIndex>=(mathbox_data_max_depth-1)) console.log("realZIndexundef", realZIndex, zIndex);
		var index = Math.trunc(xIndex + realZIndex * fft_size);
		/*if(mathbox_data[index]==undefined) console.log("Undef", index, mathbox_data.length, zIndex,
				realZIndex, mathbox_data_max_depth,
				mathbox_data_current_depth, mathbox_data_index);*/
		var dBValue = mathbox_data[index];
		//y=1;
		if(dBValue>waterfall_max_level) y = 1;
		else if(dBValue<waterfall_min_level) y = 0;
		else y = (dBValue-waterfall_min_level)/(waterfall_max_level-waterfall_min_level);
		mathbox_dbg = { dbv: dBValue, indexval: index, mbd: mathbox_data.length, yval: y };
		if(!y) y=0;
		return {y: y, dBValue: dBValue, zAdd: zAdd};
	}

    var points = view.area({
      expr: function (emit, x, z, i, j, t) {
		var y;
		remapResult=remap(x,z,t);
		if((y=remapResult.y)==undefined) return;
        emit(x, y, z+remapResult.zAdd);
      },
      width:  mathbox_waterfall_frequency_resolution,
      height: mathbox_data_max_depth - 1,
      channels: 3,
      axes: [1, 3],
    });

    var colors = view.area({
      expr: function (emit, x, z, i, j, t) {
		var dBValue;
		if((dBValue=remap(x,z,t).dBValue)==undefined) return;
		var color=waterfall_mkcolor(dBValue, mathbox_waterfall_colors);
        var b = (color&0xff)/255.0;
        var g = ((color&0xff00)>>8)/255.0;
        var r = ((color&0xff0000)>>16)/255.0;
        emit(r, g, b, 1.0);
      },
      width:  mathbox_waterfall_frequency_resolution,
      height: mathbox_data_max_depth - 1,
      channels: 4,
      axes: [1, 3],
    });

    view.surface({
      shaded: true,
      points: '<<',
      colors: '<',
      color: 0xFFFFFF,
    });

    view.surface({
      fill: false,
      lineX: false,
      lineY: false,
      points: '<<',
      colors: '<',
      color: 0xFFFFFF,
      width: 2,
      blending: 'add',
      opacity: .25,
      zBias: 5,
    });
	mathbox_mode = MATHBOX_MODES.NONE;

	//mathbox_element.style.width="100%";
	//mathbox_element.style.height="100%";

}

function mathbox_toggle()
{

	if(mathbox_mode == MATHBOX_MODES.UNINITIALIZED) mathbox_init();
	mathbox_mode = (mathbox_mode == MATHBOX_MODES.NONE) ? MATHBOX_MODES.WATERFALL : MATHBOX_MODES.NONE;
	mathbox_container.style.display = (mathbox_mode == MATHBOX_MODES.WATERFALL) ? "block" : "none";
	mathbox_clear_data();
	waterfall_clear();
}

function waterfall_clear()
{
	while(canvases.length) //delete all canvases
	{
		var x=canvases.shift();
		x.parentNode.removeChild(x);
		delete x;
	}
	add_canvas();
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

// ========================================================
// =======================  PANELS  =======================
// ========================================================

panel_margin=5.9;

function pop_bottommost_panel(from)
{
	min_order=parseInt(from[0].dataset.panelOrder);
	min_index=0;
	for(i=0;i<from.length;i++)
	{
		actual_order=parseInt(from[i].dataset.panelOrder);
		if(actual_order<min_order)
		{
			min_index=i;
			min_order=actual_order;
		}
	}
	to_return=from[min_index];
	from.splice(min_index,1);
	return to_return;
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
    //secondary_demod_update_channel_freq_from_event();
    mkscale(); //so that the secondary waterfall zoom level will be initialized
}

function secondary_demod_canvases_update_top()
{
    for(var i=0;i<2;i++) secondary_demod_canvases[i].style.top=secondary_demod_canvases[i].openwebrx_top+"px";
}

function secondary_demod_swap_canvases()
{
    console.log("swap");
    secondary_demod_canvases[0+!secondary_demod_current_canvas_index].openwebrx_top-=$(secondary_demod_canvas_container).height()*2;
    secondary_demod_current_canvas_index=0+!secondary_demod_current_canvas_index;
    secondary_demod_current_canvas_context = secondary_demod_canvases[secondary_demod_current_canvas_index].getContext("2d");
    secondary_demod_current_canvas_actual_line=$(secondary_demod_canvas_container).height()-1;
}

function secondary_demod_init()
{
    $("#openwebrx-panel-digimodes")[0].openwebrxHidden = true;
    secondary_demod_canvas_container = $("#openwebrx-digimode-canvas-container")[0];
    $(secondary_demod_canvas_container)
        .mousemove(secondary_demod_canvas_container_mousemove)
        .mouseup(secondary_demod_canvas_container_mouseup)
        .mousedown(secondary_demod_canvas_container_mousedown)
        .mouseenter(secondary_demod_canvas_container_mousein)
        .mouseleave(secondary_demod_canvas_container_mouseout);
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

function secondary_demod_push_data(x)
{
    x=Array.from(x).map((y)=>{
        var c=y.charCodeAt(0);
        if(y=="\r") return "&nbsp;";
        if(y=="\n") return "&nbsp;";
        //if(y=="\n") return "<br />";
        if(c<32||c>126) return "";
        if(y=="&") return "&amp;";
        if(y=="<") return "&lt;";
        if(y==">") return "&gt;";
        if(y==" ") return "&nbsp;";
        return y;
    }).join("");
    $("#openwebrx-cursor-blink").before("<span class=\"part\"><span class=\"subpart\">"+x+"</span></span>");
}

function secondary_demod_data_clear()
{
    $("#openwebrx-cursor-blink").prevAll().remove();
}

function secondary_demod_close_window()
{
    secondary_demod_stop();
    // toggle_panel("openwebrx-panel-digimodes", false);
}

secondary_demod_fft_offset_db=30; //need to calculate that later

function secondary_demod_waterfall_add(data)
{
    if(!secondary_demod) return;
	var w=secondary_fft_size;

	//Add line to waterfall image
	var oneline_image = secondary_demod_current_canvas_context.createImageData(w,1);
	for(x=0;x<w;x++)
	{
		var color=waterfall_mkcolor(data[x]+secondary_demod_fft_offset_db);
		for(i=0;i<4;i++) oneline_image.data[x*4+i] = ((color>>>0)>>((3-i)*8))&0xff;
	}

	//Draw image
	secondary_demod_current_canvas_context.putImageData(oneline_image, 0, secondary_demod_current_canvas_actual_line--);
    secondary_demod_canvases.map((x)=>{x.openwebrx_top += 1;});
    secondary_demod_canvases_update_top();
	if(secondary_demod_current_canvas_actual_line<0) secondary_demod_swap_canvases();
}

var secondary_demod_canvases_initialized = false;

function secondary_demod_waterfall_dequeue()
{
    if(!secondary_demod || !secondary_demod_canvases_initialized) return;
	if(secondary_demod_waterfall_queue.length) secondary_demod_waterfall_add(secondary_demod_waterfall_queue.shift());
	if(secondary_demod_waterfall_queue.length>Math.max(fft_fps/2,20)) //in case of fft overflow
	{
		console.log("secondary waterfall overflow, queue length:", secondary_demod_waterfall_queue.length);
		while(secondary_demod_waterfall_queue.length) secondary_demod_waterfall_add(secondary_demod_waterfall_queue.shift());
	}
} 

secondary_demod_listbox_updating = false;
function secondary_demod_listbox_changed()
{
    if(secondary_demod_listbox_updating) return;
    switch ($("#openwebrx-secondary-demod-listbox")[0].value)
    {
        case "none":
            demodulator_analog_replace_last();
            break;
        case "bpsk31":
            demodulator_digital_replace('bpsk31');
            break;
        case "rtty":
            demodulator_digital_replace('rtty');
            break;
    }
}

function secondary_demod_listbox_update()
{
    secondary_demod_listbox_updating = true;
    // $("#openwebrx-secondary-demod-listbox").val((secondary_demod)?secondary_demod:"none");
    console.log("update");
    secondary_demod_listbox_updating = false;
}

secondary_demod_channel_freq=1000;
function secondary_demod_update_marker()
{
    var width =  Math.max( (secondary_bw / (if_samp_rate/2)) * secondary_demod_canvas_width, 5);
    var center_at = (secondary_demod_channel_freq / (if_samp_rate/2)) * secondary_demod_canvas_width + secondary_demod_canvas_left;
    var left = center_at-width/2;
    //console.log("sdum", width, left);
    $("#openwebrx-digimode-select-channel").width(width).css("left",left+"px") 
}

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