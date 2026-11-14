#import <AVFoundation/AVFoundation.h>
#import <CoreGraphics/CoreGraphics.h>
#import <Foundation/Foundation.h>
#import <React/RCTBridgeModule.h>

@interface AnimeFrameSampler : NSObject <RCTBridgeModule>
@end

@implementation AnimeFrameSampler

RCT_EXPORT_MODULE(AnimeFrameSampler)

+ (BOOL)requiresMainQueueSetup {
  return NO;
}

static void appendRgb24Frame(CGImageRef image, CGColorSpaceRef colorSpace, NSMutableData *outData) {
  size_t w = CGImageGetWidth(image);
  size_t h = CGImageGetHeight(image);
  if (w == 0 || h == 0) return;

  CGRect cropRect = CGRectMake(w * 0.08, h * 0.10, fmax(1.0, w * 0.84), fmax(1.0, h * 0.80));
  CGImageRef cropped = CGImageCreateWithImageInRect(image, cropRect);
  CGImageRef source = cropped ? cropped : image;

  uint8_t rgba[12 * 8 * 4];
  memset(rgba, 0, sizeof(rgba));
  CGContextRef ctx = CGBitmapContextCreate(
      rgba,
      12,
      8,
      8,
      12 * 4,
      colorSpace,
      kCGImageAlphaNoneSkipLast | kCGBitmapByteOrder32Big);
  if (ctx) {
    CGContextSetInterpolationQuality(ctx, kCGInterpolationLow);
    CGContextDrawImage(ctx, CGRectMake(0, 0, 12, 8), source);
    CGContextRelease(ctx);

    uint8_t rgb[12 * 8 * 3];
    for (size_t i = 0, j = 0; i < 12 * 8 * 4; i += 4, j += 3) {
      rgb[j] = rgba[i];
      rgb[j + 1] = rgba[i + 1];
      rgb[j + 2] = rgba[i + 2];
    }
    [outData appendBytes:rgb length:sizeof(rgb)];
  }
  if (cropped) {
    CGImageRelease(cropped);
  }
}

static NSDictionary *sampleRange(
    AVAssetImageGenerator *generator,
    CGColorSpaceRef colorSpace,
    double startSec,
    double endSec) {
  NSMutableArray<NSNumber *> *times = [NSMutableArray array];
  NSMutableData *rgbData = [NSMutableData data];
  for (double t = startSec; t < endSec; t += 1.0) {
    @autoreleasepool {
      CMTime reqTime = CMTimeMakeWithSeconds(t, 600);
      CMTime actualTime = kCMTimeZero;
      NSError *err = nil;
      CGImageRef cgImg = [generator copyCGImageAtTime:reqTime actualTime:&actualTime error:&err];
      if (!cgImg) {
        continue;
      }
      appendRgb24Frame(cgImg, colorSpace, rgbData);
      CGImageRelease(cgImg);
      [times addObject:@(t)];
    }
  }
  NSString *b64 = [rgbData base64EncodedStringWithOptions:0] ?: @"";
  return @{
    @"times" : times,
    @"dataBase64" : b64,
  };
}

RCT_EXPORT_METHOD(sampleVideoWindows:(NSString *)urlString
                  durationHint:(double)durationHint
                  resolve:(RCTPromiseResolveBlock)resolve
                  reject:(RCTPromiseRejectBlock)reject) {
  dispatch_async(dispatch_get_global_queue(QOS_CLASS_UTILITY, 0), ^{
    NSURL *url = [NSURL URLWithString:urlString];
    if (!url) {
      reject(@"invalid_url", @"Invalid video URL", nil);
      return;
    }

    AVURLAsset *asset = [AVURLAsset URLAssetWithURL:url options:nil];
    double duration = durationHint;
    if (!isfinite(duration) || duration <= 0) {
      dispatch_semaphore_t sem = dispatch_semaphore_create(0);
      [asset loadValuesAsynchronouslyForKeys:@[ @"duration" ]
                           completionHandler:^{
                             dispatch_semaphore_signal(sem);
                           }];
      dispatch_semaphore_wait(sem, dispatch_time(DISPATCH_TIME_NOW, (int64_t)(15 * NSEC_PER_SEC)));
      NSError *durErr = nil;
      if ([asset statusOfValueForKey:@"duration" error:&durErr] == AVKeyValueStatusLoaded) {
        duration = CMTimeGetSeconds(asset.duration);
      }
    }

    if (!isfinite(duration) || duration < 180.0) {
      resolve(@{
        @"duration" : @(isfinite(duration) ? duration : 0.0),
        @"op" : @{@"times" : @[], @"dataBase64" : @""},
        @"ed" : @{@"times" : @[], @"dataBase64" : @""},
      });
      return;
    }

    double endingStart = fmax(duration - 240.0, duration / 2.0);
    double openingScanEnd = fmin(720.0, endingStart);

    AVAssetImageGenerator *generator = [AVAssetImageGenerator assetImageGeneratorWithAsset:asset];
    generator.appliesPreferredTrackTransform = YES;
    generator.maximumSize = CGSizeMake(64, 64);
    generator.requestedTimeToleranceBefore = CMTimeMakeWithSeconds(0.5, 600);
    generator.requestedTimeToleranceAfter = CMTimeMakeWithSeconds(0.5, 600);

    CGColorSpaceRef colorSpace = CGColorSpaceCreateDeviceRGB();
    NSDictionary *op = sampleRange(generator, colorSpace, 0.0, openingScanEnd);
    NSDictionary *ed = sampleRange(generator, colorSpace, endingStart, duration - 0.5);
    CGColorSpaceRelease(colorSpace);

    resolve(@{
      @"duration" : @(duration),
      @"op" : op,
      @"ed" : ed,
    });
  });
}

@end
