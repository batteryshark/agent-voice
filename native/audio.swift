import Foundation
import AVFoundation
import CoreAudio
import AudioToolbox
struct AudioDeviceChoice {
    let id: AudioDeviceID
    let uid: String
    let name: String
    let input: Bool
    let output: Bool
}
func audioString(_ id: AudioDeviceID, _ selector: AudioObjectPropertySelector) -> String {
    var address=AudioObjectPropertyAddress(mSelector:selector,mScope:kAudioObjectPropertyScopeGlobal,mElement:kAudioObjectPropertyElementMain)
    var size=UInt32(MemoryLayout<CFString?>.size),value: CFString?
    guard AudioObjectGetPropertyData(id,&address,0,nil,&size,&value)==noErr else { return "" }
    return value as String? ?? ""
}
func audioDevices() -> [AudioDeviceChoice] {
    var address=AudioObjectPropertyAddress(mSelector:kAudioHardwarePropertyDevices,mScope:kAudioObjectPropertyScopeGlobal,mElement:kAudioObjectPropertyElementMain)
    var size: UInt32=0
    guard AudioObjectGetPropertyDataSize(AudioObjectID(kAudioObjectSystemObject),&address,0,nil,&size)==noErr else { return [] }
    var ids=[AudioDeviceID](repeating:0,count:Int(size)/MemoryLayout<AudioDeviceID>.size)
    guard AudioObjectGetPropertyData(AudioObjectID(kAudioObjectSystemObject),&address,0,nil,&size,&ids)==noErr else { return [] }
    func hasStreams(_ id: AudioDeviceID, _ input: Bool) -> Bool {
        var property=AudioObjectPropertyAddress(mSelector:kAudioDevicePropertyStreams,mScope:input ? kAudioObjectPropertyScopeInput:kAudioObjectPropertyScopeOutput,mElement:kAudioObjectPropertyElementMain)
        var count: UInt32=0
        return AudioObjectGetPropertyDataSize(id,&property,0,nil,&count)==noErr && count>0
    }
    return ids.compactMap { id in
        let uid=audioString(id,kAudioDevicePropertyDeviceUID),name=audioString(id,kAudioObjectPropertyName)
        if uid.isEmpty || uid.hasPrefix("local.agent-voice.") { return nil }
        return AudioDeviceChoice(id:id,uid:uid,name:name,input:hasStreams(id,true),output:hasStreams(id,false))
    }
}
// Four-character CoreAudio codes, e.g. transport "blue"/"blea" (Bluetooth) or output data source "hdpn" (headphones).
func fourCC(_ value: UInt32) -> String {
    let bytes=[24,16,8,0].map { UInt8((value>>UInt32($0))&0xff) }
    return bytes.allSatisfy { $0>=32&&$0<127 } ? String(bytes:bytes,encoding:.ascii) ?? "":""
}
func audioCode(_ id: AudioDeviceID, _ selector: AudioObjectPropertySelector, _ scope: AudioObjectPropertyScope) -> String {
    var address=AudioObjectPropertyAddress(mSelector:selector,mScope:scope,mElement:kAudioObjectPropertyElementMain)
    var value: UInt32=0,size=UInt32(MemoryLayout<UInt32>.size)
    guard AudioObjectHasProperty(id,&address),AudioObjectGetPropertyData(id,&address,0,nil,&size,&value)==noErr else { return "" }
    return fourCC(value)
}
func defaultAudioDevice(input: Bool) -> AudioDeviceID? {
    var address=AudioObjectPropertyAddress(mSelector:input ? kAudioHardwarePropertyDefaultInputDevice:kAudioHardwarePropertyDefaultOutputDevice,mScope:kAudioObjectPropertyScopeGlobal,mElement:kAudioObjectPropertyElementMain)
    var id: AudioDeviceID=0,size=UInt32(MemoryLayout<AudioDeviceID>.size)
    return AudioObjectGetPropertyData(AudioObjectID(kAudioObjectSystemObject),&address,0,nil,&size,&id)==noErr && id != 0 ? id:nil
}
func assignAudioDevice(_ node: AVAudioIONode, _ device: AudioDeviceID, _ element: UInt32 = 0) throws {
    guard let unit=node.audioUnit else { throw NSError(domain:"agent-voice",code:4,userInfo:[NSLocalizedDescriptionKey:"Audio unit unavailable"]) }
    var value=device
    let status=AudioUnitSetProperty(unit,kAudioOutputUnitProperty_CurrentDevice,kAudioUnitScope_Global,element,&value,UInt32(MemoryLayout<AudioDeviceID>.size))
    if status != noErr { throw NSError(domain:"agent-voice",code:Int(status),userInfo:[NSLocalizedDescriptionKey:"Selected audio device could not be routed (\(status))"]) }
    var actual: AudioDeviceID=0,size=UInt32(MemoryLayout<AudioDeviceID>.size)
    let readStatus=AudioUnitGetProperty(unit,kAudioOutputUnitProperty_CurrentDevice,kAudioUnitScope_Global,element,&actual,&size)
    if readStatus != noErr || actual != device { throw NSError(domain:"agent-voice",code:5,userInfo:[NSLocalizedDescriptionKey:"The audio engine did not confirm the selected device."]) }
}
func audioDeviceMatches(_ node:AVAudioIONode,_ device:AudioDeviceID,_ element:UInt32)->Bool {
    guard let unit=node.audioUnit else { return false }
    var actual:AudioDeviceID=0,size=UInt32(MemoryLayout<AudioDeviceID>.size)
    return AudioUnitGetProperty(unit,kAudioOutputUnitProperty_CurrentDevice,kAudioUnitScope_Global,element,&actual,&size)==noErr && actual==device
}


// Capture without voice processing. AVAudioEngine's input and output nodes share one AUHAL unit on macOS, so an
// input-only device cannot be routed there while it plays elsewhere. A separate input-only AUHAL captures the
// selected microphone as mono float32 at its own rate; the engine keeps playback on the selected output.
final class HALCapture {
    var unit:AudioUnit?,samples=[Float](repeating:0,count:16384),handler:((UnsafePointer<Float>,Int)->Void)?
    static func check(_ status:OSStatus,_ what:String) throws {
        if status != noErr { throw NSError(domain:"agent-voice",code:Int(status),userInfo:[NSLocalizedDescriptionKey:"\(what) failed (\(status))"]) }
    }
    func start(device:AudioDeviceID,handler:@escaping (UnsafePointer<Float>,Int)->Void) throws -> Double {
        var description=AudioComponentDescription(componentType:kAudioUnitType_Output,componentSubType:kAudioUnitSubType_HALOutput,componentManufacturer:kAudioUnitManufacturer_Apple,componentFlags:0,componentFlagsMask:0)
        guard let component=AudioComponentFindNext(nil,&description) else { throw NSError(domain:"agent-voice",code:6,userInfo:[NSLocalizedDescriptionKey:"Audio input unit unavailable"]) }
        var created:AudioUnit?
        try HALCapture.check(AudioComponentInstanceNew(component,&created),"Opening the microphone")
        guard let unit=created else { throw NSError(domain:"agent-voice",code:6) }
        self.unit=unit;self.handler=handler
        var on:UInt32=1,off:UInt32=0,id=device
        let word=UInt32(MemoryLayout<UInt32>.size),formatSize=UInt32(MemoryLayout<AudioStreamBasicDescription>.size)
        try HALCapture.check(AudioUnitSetProperty(unit,kAudioOutputUnitProperty_EnableIO,kAudioUnitScope_Input,1,&on,word),"Enabling microphone input")
        try HALCapture.check(AudioUnitSetProperty(unit,kAudioOutputUnitProperty_EnableIO,kAudioUnitScope_Output,0,&off,word),"Disabling input-unit output")
        try HALCapture.check(AudioUnitSetProperty(unit,kAudioOutputUnitProperty_CurrentDevice,kAudioUnitScope_Global,0,&id,UInt32(MemoryLayout<AudioDeviceID>.size)),"Selecting the microphone")
        var hardware=AudioStreamBasicDescription(),size=formatSize
        try HALCapture.check(AudioUnitGetProperty(unit,kAudioUnitProperty_StreamFormat,kAudioUnitScope_Input,1,&hardware,&size),"Reading the microphone format")
        guard hardware.mSampleRate>0 else { throw NSError(domain:"agent-voice",code:3,userInfo:[NSLocalizedDescriptionKey:"Input device has no usable audio format."]) }
        var client=AudioStreamBasicDescription(mSampleRate:hardware.mSampleRate,mFormatID:kAudioFormatLinearPCM,mFormatFlags:kAudioFormatFlagIsFloat|kAudioFormatFlagIsPacked|kAudioFormatFlagIsNonInterleaved,
            mBytesPerPacket:4,mFramesPerPacket:1,mBytesPerFrame:4,mChannelsPerFrame:1,mBitsPerChannel:32,mReserved:0)
        try HALCapture.check(AudioUnitSetProperty(unit,kAudioUnitProperty_StreamFormat,kAudioUnitScope_Output,1,&client,formatSize),"Setting the microphone format")
        var callback=AURenderCallbackStruct(inputProc:{ refCon,flags,time,bus,frames,_ in
            let capture=Unmanaged<HALCapture>.fromOpaque(refCon).takeUnretainedValue()
            guard let unit=capture.unit,Int(frames)<=capture.samples.count else { return noErr }
            return capture.samples.withUnsafeMutableBufferPointer { pointer -> OSStatus in
                var list=AudioBufferList(mNumberBuffers:1,mBuffers:AudioBuffer(mNumberChannels:1,mDataByteSize:frames*4,mData:UnsafeMutableRawPointer(pointer.baseAddress)))
                let status=AudioUnitRender(unit,flags,time,bus,frames,&list)
                if status==noErr,let base=pointer.baseAddress { capture.handler?(base,Int(frames)) }
                return status
            }
        },inputProcRefCon:Unmanaged.passUnretained(self).toOpaque())
        try HALCapture.check(AudioUnitSetProperty(unit,kAudioOutputUnitProperty_SetInputCallback,kAudioUnitScope_Global,0,&callback,UInt32(MemoryLayout<AURenderCallbackStruct>.size)),"Installing the microphone callback")
        try HALCapture.check(AudioUnitInitialize(unit),"Initializing the microphone")
        try HALCapture.check(AudioOutputUnitStart(unit),"Starting the microphone")
        return hardware.mSampleRate
    }
    func matches(_ device:AudioDeviceID)->Bool {
        guard let unit else { return false }
        var actual:AudioDeviceID=0,size=UInt32(MemoryLayout<AudioDeviceID>.size)
        return AudioUnitGetProperty(unit,kAudioOutputUnitProperty_CurrentDevice,kAudioUnitScope_Global,0,&actual,&size)==noErr && actual==device
    }
    func stop(){
        guard let unit else { return }
        AudioOutputUnitStop(unit);AudioUnitUninitialize(unit);AudioComponentInstanceDispose(unit)
        self.unit=nil;handler=nil
    }
}

func emit(_ event:[String:Any]) {
    guard let bytes=try? JSONSerialization.data(withJSONObject:event) else { return }
    outputQueue.async { try? FileHandle.standardOutput.write(contentsOf:bytes+Data([10])) }
}
let outputQueue=DispatchQueue(label:"agent.voice.audio.pipe")
func fail(_ text:String) { emit(["type":"error","message":text]) }
func argument(_ name:String)->String? {
    guard let index=CommandLine.arguments.firstIndex(of:name),index+1<CommandLine.arguments.count else { return nil }
    return CommandLine.arguments[index+1]
}

final class NativeAudio {
    let engine=AVAudioEngine(),player=AVAudioPlayerNode(),hal=HALCapture(),captureQueue=DispatchQueue(label:"agent.voice.audio.capture")
    var active=false,tapInstalled=false
    var generation=0
    var routeTimer:Timer?
    var configurationObserver:NSObjectProtocol?
    var readyTimer:Timer?,pendingReady:[String:Any]?,receivedInput=false,readySent=false
    // voiceProcessing: Apple's echo canceller (VoiceProcessingIO). Off captures from the plain HAL input.
    func start(capture:Bool,inputUID:String,outputUID:String,voiceProcessing:Bool=true) throws {
        let processed=capture&&voiceProcessing
        let choices=audioDevices()
        let microphone=choices.first { inputUID.isEmpty||inputUID=="default" ? $0.id==defaultAudioDevice(input:true):($0.uid==inputUID||$0.name==inputUID)&&$0.input }
        let speakers=choices.first { outputUID.isEmpty||outputUID=="default" ? $0.id==defaultAudioDevice(input:false):($0.uid==outputUID||$0.name==outputUID)&&$0.output }
        guard let speakers else { throw NSError(domain:"agent-voice",code:1,userInfo:[NSLocalizedDescriptionKey:"Selected output device is unavailable. Choose /voice output again."]) }
        let output=engine.outputNode
        var common: AVAudioFormat
        if capture && !processed { guard microphone != nil else { throw NSError(domain:"agent-voice",code:2,userInfo:[NSLocalizedDescriptionKey:"Selected input device is unavailable. Choose /voice input again."]) } }
        if processed {
            guard let microphone else { throw NSError(domain:"agent-voice",code:2,userInfo:[NSLocalizedDescriptionKey:"Selected input device is unavailable. Choose /voice input again."]) }
            let input=engine.inputNode
            try input.setVoiceProcessingEnabled(true)
            // Voice processing replaces the HAL nodes. Set the selected devices on
            // the replacement unit, using its microphone and output elements.
            if inputUID != "default" { try assignAudioDevice(input,microphone.id,1) }
            if outputUID != "default" { try assignAudioDevice(output,speakers.id,0) }
            common=input.outputFormat(forBus:0)
            guard common.sampleRate>0,common.channelCount>0 else { throw NSError(domain:"agent-voice",code:3,userInfo:[NSLocalizedDescriptionKey:"Input device has no usable audio format."]) }
            // VoiceProcessingIO requires EXACTLY matching client input/output formats.
            // The mixer performs conversion from speech audio into that shared format.
            engine.connect(engine.mainMixerNode,to:output,format:common)
            let mono=AVAudioFormat(commonFormat:.pcmFormatInt16,sampleRate:16000,channels:1,interleaved:true)!
            let cleanMono=AVAudioFormat(commonFormat:.pcmFormatFloat32,sampleRate:common.sampleRate,channels:1,interleaved:false)!
            guard let converter=AVAudioConverter(from:cleanMono,to:mono) else { throw NSError(domain:"agent-voice",code:4) }
            input.installTap(onBus:0,bufferSize:1024,format:common) { [weak self] buffer,_ in
                guard let self,self.active else { return }
                let capacity=AVAudioFrameCount(ceil(Double(buffer.frameLength)*16000/common.sampleRate)+32)
                guard let converted=AVAudioPCMBuffer(pcmFormat:mono,frameCapacity:capacity) else { return }
                guard let clean=AVAudioPCMBuffer(pcmFormat:cleanMono,frameCapacity:buffer.frameLength),let sourceChannels=buffer.floatChannelData,let cleanChannel=clean.floatChannelData else { return }
                clean.frameLength=buffer.frameLength
                memcpy(cleanChannel[0],sourceChannels[0],Int(buffer.frameLength)*MemoryLayout<Float>.size)
                var used=false,error:NSError?
                converter.convert(to:converted,error:&error) { _,status in
                    if used { status.pointee = .noDataNow;return nil }
                    used=true;status.pointee = .haveData;return clean
                }
                guard error==nil,let samples=converted.int16ChannelData else { return }
                if converted.frameLength>0 { DispatchQueue.main.async { [weak self] in self?.receivedInput=true } }
                emit(["type":"pcm","data":Data(bytes:samples[0],count:Int(converted.frameLength)*2).base64EncodedString()])
            }
            tapInstalled=true
        } else {
            if outputUID != "default" { try assignAudioDevice(output,speakers.id) }
            common=output.inputFormat(forBus:0)
        }
        engine.attach(player)
        let speechFormat=AVAudioFormat(commonFormat:.pcmFormatFloat32,sampleRate:48000,channels:1,interleaved:false)!
        engine.connect(player,to:engine.mainMixerNode,format:speechFormat)
        // Reapply after graph construction so automatic mixer negotiation cannot reset it.
        if processed { engine.connect(engine.mainMixerNode,to:output,format:common) }
        active=true
        let startupDeadline=Date().addingTimeInterval(5)
        var lastConfigurationChange=Date(),restartCount=0
        pendingReady=["type":"ready","echoCancellation":processed,"input":capture ? microphone!.uid:"off","output":speakers.uid,"sampleRate":common.sampleRate,"channels":common.channelCount]
        // Bluetooth can stop the engine while entering its microphone profile.
        // Recover only during startup on the same confirmed devices, before any
        // speech is accepted. Reset the player's clock as well as the engine.
        configurationObserver=NotificationCenter.default.addObserver(forName:.AVAudioEngineConfigurationChange,object:engine,queue:.main) { [weak self] _ in
            guard let self,self.active else { return }
            lastConfigurationChange=Date()
            if !self.engine.isRunning && !self.readySent && restartCount<3 && Date()<startupDeadline {
                restartCount+=1
                DispatchQueue.main.asyncAfter(deadline:.now()+0.15) { [weak self] in
                    guard let self,self.active,!self.engine.isRunning,!self.readySent else { return }
                    guard audioDeviceMatches(output,speakers.id,0),!processed || audioDeviceMatches(self.engine.inputNode,microphone!.id,1) else { self.close();fail("Selected audio devices changed during startup.");return }
                    guard !processed || self.engine.inputNode.outputFormat(forBus:0).isEqual(common) && output.inputFormat(forBus:0).isEqual(common) else { self.close();fail("Selected audio devices changed format during startup. Start voice again.");return }
                    do { self.player.stop();try self.engine.start();self.player.play() }
                    catch { self.close();fail("Audio could not restart after Bluetooth setup: \(error.localizedDescription)") }
                }
            }
        }
        do {
            try engine.start();player.play()
            if capture && !processed { try startPlainCapture(microphone!.id) }
        }
        catch { close();throw error }
        readyTimer=Timer.scheduledTimer(withTimeInterval:0.1,repeats:true) { [weak self] _ in
            guard let self,self.active else { return }
            if self.engine.isRunning && (!capture || self.receivedInput) && Date().timeIntervalSince(lastConfigurationChange)>0.3 {
                self.readyTimer?.invalidate();self.readyTimer=nil;self.readySent=true
                if let event=self.pendingReady { emit(event);self.pendingReady=nil }
            } else if Date()>startupDeadline {
                self.close();fail("The selected microphone and output did not finish starting. Start voice again or choose another audio route.")
            }
        }
        routeTimer=Timer.scheduledTimer(withTimeInterval:1,repeats:true) { [weak self] _ in
            guard let self,self.active else { return }
            let available=Set(audioDevices().map { $0.id })
            let outputOK=available.contains(speakers.id) && (outputUID=="default" || audioDeviceMatches(output,speakers.id,0))
            let inputOK = !capture || (available.contains(microphone!.id) && (processed ? inputUID=="default" || audioDeviceMatches(self.engine.inputNode,microphone!.id,1):self.hal.matches(microphone!.id)))
            if !outputOK || !inputOK || (self.readySent && !self.engine.isRunning) {
                self.close()
                fail("Voice paused because the selected audio route changed or disconnected. Choose /voice devices and enable voice again.")
            }
        }
    }
    // Same 16 kHz mono s16le stream as the voice-processing tap. Conversion runs off the real-time thread.
    func startPlainCapture(_ device:AudioDeviceID) throws {
        let queue=captureQueue
        var converter:AVAudioConverter?,clean:AVAudioFormat?
        let mono=AVAudioFormat(commonFormat:.pcmFormatInt16,sampleRate:16000,channels:1,interleaved:true)!
        let rate=try hal.start(device:device) { [weak self] samples,count in
            let copy=Array(UnsafeBufferPointer(start:samples,count:count))
            queue.async {
                guard let self,self.active,let clean,let converter,count>0,
                      let source=AVAudioPCMBuffer(pcmFormat:clean,frameCapacity:AVAudioFrameCount(count)),let channel=source.floatChannelData else { return }
                source.frameLength=AVAudioFrameCount(count)
                _=copy.withUnsafeBufferPointer { memcpy(channel[0],$0.baseAddress!,count*MemoryLayout<Float>.size) }
                let capacity=AVAudioFrameCount(ceil(Double(count)*16000/clean.sampleRate)+32)
                guard let converted=AVAudioPCMBuffer(pcmFormat:mono,frameCapacity:capacity) else { return }
                var used=false,error:NSError?
                converter.convert(to:converted,error:&error) { _,status in
                    if used { status.pointee = .noDataNow;return nil }
                    used=true;status.pointee = .haveData;return source
                }
                guard error==nil,let samples=converted.int16ChannelData else { return }
                if converted.frameLength>0 { DispatchQueue.main.async { [weak self] in self?.receivedInput=true } }
                emit(["type":"pcm","data":Data(bytes:samples[0],count:Int(converted.frameLength)*2).base64EncodedString()])
            }
        }
        queue.sync {
            clean=AVAudioFormat(commonFormat:.pcmFormatFloat32,sampleRate:rate,channels:1,interleaved:false)
            converter=clean.flatMap { AVAudioConverter(from:$0,to:mono) }
        }
        guard converter != nil else { throw NSError(domain:"agent-voice",code:4,userInfo:[NSLocalizedDescriptionKey:"Microphone audio cannot be converted."]) }
    }
    func play(_ data:Data,id:Int) {
        guard active,data.count%4==0,
              let format=AVAudioFormat(commonFormat:.pcmFormatFloat32,sampleRate:48000,channels:1,interleaved:false),
              let buffer=AVAudioPCMBuffer(pcmFormat:format,frameCapacity:AVAudioFrameCount(data.count/4)),
              let channel=buffer.floatChannelData else { fail("Invalid speech buffer");return }
        buffer.frameLength=buffer.frameCapacity
        data.withUnsafeBytes { bytes in if let source=bytes.baseAddress { memcpy(channel[0],source,data.count) } }
        let epoch=generation
        player.scheduleBuffer(buffer,completionCallbackType:.dataPlayedBack) { [weak self] _ in
            if self?.generation==epoch { emit(["type":"played","id":id]) }
        }
        emit(["type":"playing","id":id])
    }
    func stopPlayback(){generation+=1;player.stop();if active { player.play() }}
    func close(){
        readyTimer?.invalidate();readyTimer=nil;pendingReady=nil
        if let configurationObserver { NotificationCenter.default.removeObserver(configurationObserver);self.configurationObserver=nil }
        routeTimer?.invalidate();routeTimer=nil
        active=false;generation+=1;player.stop()
        if tapInstalled { engine.inputNode.removeTap(onBus:0);tapInstalled=false }
        hal.stop()
        engine.stop()
    }
}
let audio=NativeAudio()
if CommandLine.arguments.contains("--devices") {
    let defaultInput=defaultAudioDevice(input:true),defaultOutput=defaultAudioDevice(input:false)
    let choices=audioDevices().map { ["id":$0.uid,"name":$0.name,"input":$0.input,"output":$0.output,
        "defaultInput":$0.id==defaultInput,"defaultOutput":$0.id==defaultOutput,
        "transport":audioCode($0.id,kAudioDevicePropertyTransportType,kAudioObjectPropertyScopeGlobal),
        "dataSource":$0.output ? audioCode($0.id,kAudioDevicePropertyDataSource,kAudioObjectPropertyScopeOutput):""] as [String:Any] }
    let data=try! JSONSerialization.data(withJSONObject:choices)
    FileHandle.standardOutput.write(data+Data([10]))
} else {
    let capture=CommandLine.arguments.contains("--capture")
    do {
        // Older plugin code passes no flag and expects echo cancellation on.
        try audio.start(capture:capture,inputUID:argument("--input") ?? "default",outputUID:argument("--output") ?? "default",voiceProcessing:argument("--echo-cancellation") != "off")
        DispatchQueue.global().async {
            while let line=readLine() {
                guard let bytes=line.data(using:.utf8),let event=(try? JSONSerialization.jsonObject(with:bytes)) as? [String:Any] else { continue }
                DispatchQueue.main.async {
                    switch event["type"] as? String {
                    case "play":if let value=event["data"] as? String,let data=Data(base64Encoded:value),let id=event["id"] as? Int { audio.play(data,id:id) }
                    case "stop":audio.stopPlayback()
                    case "close":audio.close();exit(0)
                    default:break
                    }
                }
            }
            DispatchQueue.main.async { audio.close();exit(0) }
        }
        RunLoop.main.run()
    } catch {
        audio.close()
        let error=error as NSError
        FileHandle.standardOutput.write(try! JSONSerialization.data(withJSONObject:["type":"error","message":"Audio initialization failed: \(error.localizedDescription) (\(error.code))"]) + Data([10]))
        exit(1)
    }
}
