#import <AppKit/AppKit.h>
#import <CoreServices/CoreServices.h>
#import <Foundation/Foundation.h>

@interface Launcher : NSObject <NSApplicationDelegate>
@property(nonatomic, strong) NSTask *agent;
@property(nonatomic, strong) NSMutableArray<NSString *> *pending;
@end

@implementation Launcher

- (void)applicationDidFinishLaunching:(NSNotification *)notification {
    LSSetDefaultHandlerForURLScheme(CFSTR("agy-lab"), CFSTR("com.local.agy-lab"));
    [self startAgent:self.pending mainInstance:YES];
    [self.pending removeAllObjects];
}

- (void)application:(NSApplication *)application openURLs:(NSArray<NSURL *> *)urls {
    NSMutableArray<NSString *> *values = [NSMutableArray array];
    for (NSURL *url in urls) {
        if ([url.scheme isEqualToString:@"agy-lab"]) {
            [values addObject:url.absoluteString];
        }
    }
    if (values.count == 0) return;
    if (self.agent.running) {
        [self startAgent:values mainInstance:NO];
    } else {
        [self.pending addObjectsFromArray:values];
    }
}

- (void)startAgent:(NSArray<NSString *> *)arguments mainInstance:(BOOL)mainInstance {
    NSString *resources = NSBundle.mainBundle.resourcePath;
    NSString *host = [resources stringByAppendingPathComponent:@"Electron.app/Contents/MacOS/Electron"];
    NSString *archive = [resources stringByAppendingPathComponent:@"app.asar"];
    NSTask *task = [[NSTask alloc] init];
    task.executableURL = [NSURL fileURLWithPath:host];
    task.arguments = [@[archive] arrayByAddingObjectsFromArray:arguments ?: @[]];
    if (mainInstance) {
        self.agent = task;
        task.terminationHandler = ^(NSTask *finished) {
            dispatch_async(dispatch_get_main_queue(), ^{ [NSApp terminate:nil]; });
        };
    }
    NSError *error;
    if (![task launchAndReturnError:&error]) {
        NSLog(@"Unable to start AGY Lab: %@", error.localizedDescription);
        [NSApp terminate:nil];
    }
}
@end

int main(void) {
    @autoreleasepool {
        NSApplication *application = NSApplication.sharedApplication;
        Launcher *delegate = [[Launcher alloc] init];
        delegate.pending = [NSMutableArray array];
        application.delegate = delegate;
        [application setActivationPolicy:NSApplicationActivationPolicyAccessory];
        [application run];
    }
    return 0;
}
